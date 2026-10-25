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
import { sendMagicLinkSentScreen } from './views/magic-link-sent/magic-link-sent';
import { sendProviderChoice, sendSignIn } from './views/sign-in/sign-in';
import { sendSignInMessage } from './views/sign-in-message/sign-in-message';
import { GITHUB_CALLBACK_PATH, originOf } from './callback-url';
import { callerOf } from './caller.middleware';
import { GithubAuthService } from './github.service';
import { CompletedLogin } from './login-result';
import { MagicLinkService } from './magic-link.service';
import { OidcService, safeRedirect } from './oidc.service';
import { SessionService } from './session.service';
import { catchAllProviders, emailDomain, providersForEmail } from './sign-in-routing';
import { mintToken } from './tokens';

const BROWSER_BINDING_COOKIE = 'speicher_binding';

/**
 * Sign-in, sign-out, and identity endpoints
 *
 * Supported Flows: OIDC, GitHub, magic-link email, dev-login
 * Also handles first-admin promotion during setup
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
    private readonly github: GithubAuthService,
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
    const providers = this.config.providerShortIds;

    const devLoginEnabled = env('SPEICHER_DEV_LOGIN');
    const chosenProvider =
      providerId ?? (providers.length === 1 && !devLoginEnabled ? providers[0] : undefined);
    if (!chosenProvider || !this.config.provider(chosenProvider)) {
      sendSignIn(req, res, this.config, safeRedirect(redirectTo), {
        formActions: this.signInFormActions(),
      });
      return;
    }

    await this.startSignIn(req, res, tenant.id, chosenProvider, safeRedirect(redirectTo));
  }

  /**
   * Find the providers for a typed email address and start the sign-in
   */
  @Post('discover')
  async discover(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { email?: unknown; provider?: unknown; redirect_to?: unknown },
  ): Promise<void> {
    const tenant = await this.tenancy.resolveTenant(req);
    const redirectTo = safeRedirect(typeof body.redirect_to === 'string' ? body.redirect_to : '/');
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (emailDomain(email) === null) {
      sendSignIn(req, res, this.config, redirectTo, {
        notice: 'Enter your full email address.',
        email,
        formActions: this.signInFormActions(),
      });
      return;
    }

    const offered = providersForEmail(this.config, email);
    const chosen = typeof body.provider === 'string' ? body.provider : undefined;
    if (chosen !== undefined && offered.includes(chosen)) {
      await this.startSignIn(req, res, tenant.id, chosen, redirectTo, email);
      return;
    }
    if (offered.length === 1) {
      await this.startSignIn(req, res, tenant.id, offered[0], redirectTo, email);
      return;
    }
    if (offered.length === 0) {
      const domain = emailDomain(email);
      const notice = catchAllProviders(this.config).length
        ? `No sign-in is set up for ${domain} addresses. Sign in with one of the options below.`
        : `Addresses at ${domain} cannot sign in here. Use an address from your organization's domain.`;
      sendSignIn(req, res, this.config, redirectTo, {
        notice,
        email,
        formActions: this.signInFormActions(),
      });
      return;
    }
    sendProviderChoice(req, res, this.config, offered, email, redirectTo, this.signInFormActions());
  }

  private signInFormActions(): string[] {
    return this.config.providerShortIds.flatMap((id) => [
      ...this.oidc.authorizationOrigins(id),
      ...[this.github.authorizationOrigin(id)].filter((origin): origin is string => !!origin),
    ]);
  }

  /**
   * Start a sign-in with a provider
   */
  private async startSignIn(
    req: Request,
    res: Response,
    tenantId: string,
    providerId: string,
    redirectTo: string,
    email?: string,
  ): Promise<void> {
    const kind = providerType(this.config.provider(providerId)!);
    if (kind === 'magic-link') {
      if (email === undefined) {
        sendMagicLink(req, res, this.config, providerId, redirectTo);
      } else {
        return await this.sendMagicLinkTo(req, res, tenantId, providerId, email, redirectTo);
      }
      return;
    }
    if (kind === 'github') {
      await this.startRedirect(req, res, providerId, redirectTo, () =>
        this.github.authorizationUrl(tenantId, providerId, this.githubCallbackUri(req), redirectTo),
      );
      return;
    }
    if (kind !== 'oidc') {
      sendSignIn(req, res, this.config, redirectTo, { formActions: this.signInFormActions() });
      return;
    }

    await this.startRedirect(req, res, providerId, redirectTo, () =>
      this.oidc.authorizationUrl(tenantId, providerId, this.callbackUri(req), redirectTo, {
        loginHint: email,
      }),
    );
  }

  /**
   * Redirect caller to provider
   */
  private async startRedirect(
    req: Request,
    res: Response,
    providerId: string,
    redirectTo: string,
    build: () => Promise<string>,
  ): Promise<void> {
    try {
      res.redirect(302, await build());
    } catch (err) {
      const provider = this.config.provider(providerId);
      this.log.error('could not start login', {
        provider: providerId,
        issuer: provider && 'issuer' in provider ? provider.issuer : undefined,
        error: (err as Error).message,
      });

      sendSignIn(req, res, this.config, safeRedirect(redirectTo), {
        notice: `Could not reach the "${providerId}" sign-in provider.`,
        formActions: this.signInFormActions(),
      });
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
    await this.completeCallback(req, res, code, state, (tenantId, verified, issued) =>
      this.oidc.completeLogin(tenantId, verified, issued, this.callbackUri(req)),
    );
  }

  /**
   * Complete a GitHub login
   */
  @Get('github/callback')
  async githubCallback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
  ): Promise<void> {
    await this.completeCallback(req, res, code, state, (tenantId, verified, issued) =>
      this.github.completeLogin(tenantId, verified, issued, this.githubCallbackUri(req)),
    );
  }

  private async completeCallback(
    req: Request,
    res: Response,
    code: string | undefined,
    state: string | undefined,
    complete: (tenantId: string, code: string, state: string) => Promise<CompletedLogin>,
  ): Promise<void> {
    const tenant = await this.tenancy.resolveTenant(req);
    if (!code || !state) {
      sendSignInMessage(
        req,
        res,
        this.config,
        400,
        'The sign-in provider did not return an authorization code. Try signing in again.',
      );
      return;
    }
    try {
      await this.finishLogin(tenant.id, await complete(tenant.id, code, state), res);
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

  private async finishLogin(
    tenantId: string,
    result: CompletedLogin,
    res: Response,
  ): Promise<void> {
    if (result.namesFirstAdmin) {
      const written = await nameFirstAdmin(
        tenantId,
        result.identity,
        this.config.adminPrincipals().length > 0,
      );

      if (written) await this.watcher.refresh();
    }

    await this.sessions.create(tenantId, result.identity, result.rawGroupIds, res);
    await this.noteAdminLogin(tenantId, result.identity, result.rawGroupIds);
    res.redirect(302, result.redirectTo);
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
    @Body() body: { email?: unknown; provider?: unknown; redirect_to?: unknown },
  ): Promise<void> {
    const tenant = await this.tenancy.resolveTenant(req);
    const requested = typeof body.provider === 'string' ? body.provider : undefined;
    const providerId =
      requested ??
      this.config.providerShortIds.find(
        (id) => providerType(this.config.provider(id)!) === 'magic-link',
      );
    const redirectTo = safeRedirect(typeof body.redirect_to === 'string' ? body.redirect_to : '/');
    await this.sendMagicLinkTo(
      req,
      res,
      tenant.id,
      providerId,
      typeof body.email === 'string' ? body.email : '',
      redirectTo,
    );
  }

  private async sendMagicLinkTo(
    req: Request,
    res: Response,
    tenantId: string,
    providerId: string | undefined,
    email: string,
    redirectTo: string,
  ): Promise<void> {
    if (providerId && email.includes('@')) {
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
          .request(tenantId, providerId, email, originOf(req), binding, redirectTo)
          .catch((err) => this.log.error('magic link failed', { error: (err as Error).message }));
      }
    }

    // Always the same response so a valid address cannot be distinguished
    sendMagicLinkSentScreen(req, res, this.config, email.trim(), redirectTo);
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
    const redeemed = await this.magic.redeem(
      tenant.id,
      token,
      typeof binding === 'string' ? binding : null,
    );
    if (!redeemed) {
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
    await this.sessions.create(tenant.id, redeemed.identity, [], res);
    await this.noteAdminLogin(tenant.id, redeemed.identity, []);
    res.redirect(302, redeemed.redirectTo);
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
    const providerId = this.config.defaultProviderId ?? this.config.providerShortIds[0] ?? 'dev';

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

  private githubCallbackUri(req: Request): string {
    return `${originOf(req)}${GITHUB_CALLBACK_PATH}`;
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
