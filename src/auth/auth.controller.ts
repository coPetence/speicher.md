import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';

import { CallerIdentity, isAdminCaller, principalsFor } from '../authz/caller';
import { env } from '../common/env';
import { Logger, rootLogger } from '../common/logger';
import { ConfigService } from '../config/config.service';
import { providerType } from '../config/types';
import { ConfigWatcher } from '../config/watcher';
import { getSequelize } from '../db/sequelize';
import { TenancyService } from '../db/tenancy';
import { nameFirstAdmin } from '../dashboard/setup/first-admin';
import { SetupService } from '../dashboard/setup/setup.service';
import { sendMagicLink } from './views/magic-link/magic-link';
import { sendSignIn } from './views/sign-in/sign-in';
import { sendSignInMessage } from './views/sign-in-message/sign-in-message';
import { callerOf } from './caller.middleware';
import { MagicLinkService } from './magic-link.service';
import { OidcService, safeRedirect } from './oidc.service';
import { SessionService } from './session.service';
import { mintToken } from './tokens';

const BROWSER_BINDING_COOKIE = 'speicher_binding';

/**
 * Sign-in, sign-out, and identity endpoints
 *
 * Three flows: OIDC, magic-link email, dev-login
 * Handles the first-admin promotion when the first admin signs in
 *
 * All routes are under `/api/auth`
 */
@Controller('api/auth')
export class AuthController {
  private readonly log: Logger = rootLogger.child('auth');

  constructor(
    private readonly config: ConfigService,
    private readonly sessions: SessionService,
    private readonly oidc: OidcService,
    private readonly magic: MagicLinkService,
    private readonly tenancy: TenancyService,
    private readonly setup: SetupService,
    private readonly watcher: ConfigWatcher,
  ) {}

  /**
   * Start a sign-in, redirecting to the chosen provider
   */
  @Get('login')
  async login(
    @Req() req: Request,
    @Res() res: Response,
    @Query('provider') providerId?: string,
    @Query('redirect_to') redirectTo = '/',
  ): Promise<void> {
    const tenant = await this.tenancy.resolveTenant(req);
    const providers = this.config.providerIds;

    const devLoginEnabled = env('SPEICHER_DEV_LOGIN');
    const chosen =
      providerId ?? (providers.length === 1 && !devLoginEnabled ? providers[0] : undefined);
    if (!chosen || !this.config.provider(chosen)) {
      sendSignIn(req, res, this.config, safeRedirect(redirectTo));
      return;
    }

    const kind = providerType(this.config.provider(chosen)!);
    if (kind === 'magic-link') {
      sendMagicLink(req, res, this.config, chosen, safeRedirect(redirectTo));
      return;
    }
    if (kind !== 'oidc') {
      sendSignIn(req, res, this.config, safeRedirect(redirectTo));
      return;
    }

    try {
      const url = await this.oidc.authorizationUrl(
        tenant.id,
        chosen,
        this.callbackUri(req),
        safeRedirect(redirectTo),
      );
      res.redirect(302, url);
    } catch (err) {
      const provider = this.config.provider(chosen);
      this.log.error('could not start login', {
        provider: chosen,

        issuer: provider && 'issuer' in provider ? provider.issuer : undefined,
        error: (err as Error).message,
      });

      sendSignIn(
        req,
        res,
        this.config,
        safeRedirect(redirectTo),
        `Could not reach the "${chosen}" sign-in provider.`,
      );
    }
  }

  /**
   * Complete an OIDC login after the provider returns the caller here
   *
   * Promotes the first admin on the first admin sign-in
   */
  @Get('callback')
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
  ): Promise<void> {
    const tenant = await this.tenancy.resolveTenant(req);
    if (!code || !state) {
      sendSignInMessage(
        req,
        res,
        this.config,
        400,
        'The sign-in provider did not return an authorization code. Try signing in ' + 'again.',
      );
      return;
    }
    try {
      const result = await this.oidc.completeLogin(tenant.id, code, state, this.callbackUri(req));

      if (result.namesFirstAdmin) {
        const written = await nameFirstAdmin(
          tenant.id,
          result.identity,
          this.config.adminPrincipals().length > 0,
        );

        if (written) await this.watcher.refresh();
      }

      await this.sessions.create(tenant.id, result.identity, result.rawGroupIds, res);
      await this.noteAdminLogin(tenant.id, result.identity, result.rawGroupIds);
      res.redirect(302, result.redirectTo);
    } catch (err) {
      this.log.warn('login callback failed', { error: (err as Error).message });
      sendSignInMessage(
        req,
        res,
        this.config,
        400,
        'The sign-in could not be completed. Try signing in again.',
      );
    }
  }

  /**
   * Request a magic link sent by email
   *
   * The link is bound to the browser via a cookie to prevent token theft from email
   * Rate-limited per IP to 20 requests per 15-minute window
   */
  @Post('magic')
  async requestMagicLink(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { email?: string; provider?: string },
  ): Promise<void> {
    const tenant = await this.tenancy.resolveTenant(req);
    const providerId =
      body.provider ??
      this.config.providerIds.find(
        (id) => providerType(this.config.provider(id)!) === 'magic-link',
      );

    if (providerId && typeof body.email === 'string' && body.email.includes('@')) {
      if (await this.perIpOk(req)) {
        let binding = req.cookies?.[BROWSER_BINDING_COOKIE];
        if (typeof binding !== 'string' || !binding) {
          binding = mintToken(16);
          res.cookie(BROWSER_BINDING_COOKIE, binding, {
            httpOnly: true,
            secure: !env('SPEICHER_INSECURE_COOKIES'),
            sameSite: 'lax',
            path: '/',
            maxAge: 60 * 60_000,
          });
        }
        await this.magic
          .request(tenant.id, providerId, body.email, originOf(req), binding)
          .catch((err) => this.log.error('magic link failed', { error: (err as Error).message }));
      }
    }

    // Always the same response so a valid address cannot be distinguished
    sendSignInMessage(
      req,
      res,
      this.config,
      200,
      'If this address is registered, a sign-in link has been sent. Check your inbox.',
    );
  }

  /**
   * Redeem a magic link from the email
   *
   * Requires the browser binding cookie set when the link was requested
   */
  @Get('magic/callback')
  async redeemMagicLink(
    @Req() req: Request,
    @Res() res: Response,
    @Query('token') token?: string,
  ): Promise<void> {
    const tenant = await this.tenancy.resolveTenant(req);
    if (!token) {
      sendSignInMessage(
        req,
        res,
        this.config,
        400,
        'The sign-in link is missing a token. Use the full link from the email.',
      );
      return;
    }
    const binding = req.cookies?.[BROWSER_BINDING_COOKIE];
    const identity = await this.magic.redeem(
      tenant.id,
      token,
      typeof binding === 'string' ? binding : null,
    );
    if (!identity) {
      sendSignInMessage(
        req,
        res,
        this.config,
        400,
        'This link is invalid, expired, or was requested from a different browser. ' +
          'Request a new sign-in link.',
      );
      return;
    }
    await this.sessions.create(tenant.id, identity, [], res);
    await this.noteAdminLogin(tenant.id, identity, []);
    res.redirect(302, '/');
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.sessions.destroy(req, res);
    res.redirect(302, '/');
  }

  /**
   * Development-only: create a session for any identity, no authentication
   *
   * Only reachable when SPEICHER_DEV_LOGIN is set
   */
  @Get('dev-login')
  async devLogin(
    @Req() req: Request,
    @Res() res: Response,
    @Query('subject') subject?: string,
    @Query('groups') groups = '',
    @Query('email') email?: string,
    @Query('redirect_to') redirectTo = '/',
  ): Promise<void> {
    if (!env('SPEICHER_DEV_LOGIN')) {
      sendSignInMessage(
        req,
        res,
        this.config,
        404,
        'Development sign-in is not available on this instance.',
      );
      return;
    }
    if (!subject) {
      sendSignInMessage(
        req,
        res,
        this.config,
        400,
        'A subject is required for development sign-in.',
      );
      return;
    }

    const tenant = await this.tenancy.resolveTenant(req);
    const providerId = this.config.defaultProviderId ?? this.config.providerIds[0] ?? 'dev';

    this.log.warn('dev-login issued a session without authentication', { subject });
    const groupIds = groups
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean);
    await this.sessions.create(
      tenant.id,
      { provider: providerId, subject, email: email ?? null, displayName: subject },
      groupIds,
      res,
    );
    await this.noteAdminLogin(
      tenant.id,
      { provider: providerId, subject, email: email ?? null, displayName: subject },
      groupIds,
    );
    res.redirect(302, safeRedirect(redirectTo));
  }

  /**
   * Close the setup claim window on the first admin login
   */
  private async noteAdminLogin(
    tenantId: string,
    identity: CallerIdentity,
    rawGroupIds: string[],
  ): Promise<void> {
    const groups = this.config.resolveInternalGroups(identity.provider, rawGroupIds, identity);
    const principals = principalsFor(identity, groups);
    if (!isAdminCaller(principals, this.config.adminPrincipals(), false)) return;
    if (await this.setup.latchFirstAdminLogin(tenantId)) {
      this.log.info('first administrator login; the setup claim window is closed', {
        provider: identity.provider,
      });
    }
  }

  /**
   * Return the current caller's identity summary
   */
  @Get('whoami')
  async whoami(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    res.status(200).json({
      authenticated: caller.identity !== null,
      provider: caller.identity?.provider ?? null,
      groups: caller.internalGroups,

      admin: caller.isAdmin,
      via_bearer: caller.viaBearer,
    });
  }

  private callbackUri(req: Request): string {
    return `${originOf(req)}/api/auth/callback`;
  }

  /**
   * Rate-limit magic-link requests per IP to 20 per 15-minute window
   *
   * Uses a Postgres upsert to check and increment atomically
   */
  private async perIpOk(req: Request): Promise<boolean> {
    const bucket = `login-ip:${req.ip ?? 'unknown'}`;
    const windowStart = new Date(Math.floor(Date.now() / 900_000) * 900_000);
    const rows = await getSequelize().query<{ count: number }>(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (:bucket, :windowStart, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
       RETURNING count`,
      { type: QueryTypes.SELECT, replacements: { bucket, windowStart } },
    );
    return (rows[0]?.count ?? 0) <= 20;
  }
}

/**
 * Origin for callback URLs and magic links
 *
 * Not req.protocol when SPEICHER_PUBLIC_URL is set: wrong behind a reverse proxy
 */
function originOf(req: Request): string {
  const configured = env('SPEICHER_PUBLIC_URL');
  if (configured) return configured.replace(/\/+$/, '');

  return `${req.protocol}://${req.get('host')}`;
}
