import { Body, Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { Logger, rootLogger } from '../../common/logger';
import { ConfigService } from '../../config/config.service';
import { TenancyService } from '../../db/tenancy';
import { sendOauthConsent } from '../views/oauth-consent/oauth-consent';
import { sendOauthMessage } from '../views/oauth-message/oauth-message';
import { callerOf } from '../caller.middleware';
import {
  CIMD_DEPS,
  CimdDeps,
  CimdError,
  ClientMetadata,
  redirectUriAllowed,
  resolveClientMetadata,
} from './cimd';
import { OAUTH_AUTHORIZE_PATH, issuerUrl, mcpResourceIdentifier } from './metadata';
import { OauthError, OauthService } from './oauth.service';

/**
 * OAuth 2.0 authorization code grant with PKCE (S256)
 *
 * Clients identify by a published metadata document URL
 * Tokens are scoped to this instance's MCP resource identifier
 */
@Controller('api/auth/oauth')
export class OauthController {
  private readonly log: Logger = rootLogger.child('auth.oauth');

  constructor(
    private readonly config: ConfigService,
    private readonly oauth: OauthService,
    private readonly tenancy: TenancyService,

    @Inject(CIMD_DEPS) private readonly cimdDeps: CimdDeps | null,
  ) {}

  @Get('authorize')
  async authorize(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, string>,
  ): Promise<void> {
    const checked = await this.check(req, res, query);
    if (checked === null) return;

    const caller = callerOf(req);

    if (caller.identity === null || caller.viaBearer) {
      const back = `${OAUTH_AUTHORIZE_PATH}?${new URLSearchParams(query).toString()}`;
      res.redirect(302, `/api/auth/login?redirect_to=${encodeURIComponent(back)}`);
      return;
    }

    sendOauthConsent(
      req,
      res,
      this.config,
      checked.client.clientName ?? checked.client.clientId,
      query,
    );
  }

  @Post('consent')
  async consent(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: Record<string, string>,
  ): Promise<void> {
    const tenant = await this.tenancy.resolveTenant(req);

    const checked = await this.check(req, res, body);
    if (checked === null) return;

    const caller = callerOf(req);
    if (caller.identity === null || caller.viaBearer) {
      sendOauthMessage(
        req,
        res,
        this.config,
        400,
        'Sign in to approve this connection. Consent requires an active session.',
      );
      return;
    }

    const code = await this.oauth.issueCode({
      tenantId: tenant.id,
      clientId: checked.client.clientId,
      clientName: checked.client.clientName,
      redirectUri: checked.redirectUri,
      resource: checked.resource,
      codeChallenge: body.code_challenge,
      identity: caller.identity,
      rawGroupIds: caller.rawGroupIds,
    });

    const target = new URL(checked.redirectUri);
    target.searchParams.set('code', code);
    if (body.state) target.searchParams.set('state', body.state);

    const issuer = issuerUrl();
    if (issuer !== null) target.searchParams.set('iss', issuer);

    this.log.info('authorization granted', {
      client_id: checked.client.clientId,
      provider: caller.identity.provider,
    });
    res.redirect(302, target.toString());
  }

  @Post('token')
  async token(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: Record<string, string>,
  ): Promise<void> {
    const tenant = await this.tenancy.resolveTenant(req);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');

    try {
      const clientId = body.client_id ?? '';
      if (clientId === '') throw new OauthError('invalid_request', 'client_id is required');

      const issued =
        body.grant_type === 'refresh_token'
          ? await this.oauth.refresh(tenant.id, body.refresh_token ?? '', clientId)
          : body.grant_type === 'authorization_code'
            ? await this.oauth.exchangeCode(
                tenant.id,
                body.code ?? '',
                clientId,
                body.redirect_uri ?? '',
                body.code_verifier ?? '',
              )
            : null;
      if (issued === null) {
        throw new OauthError(
          'unsupported_grant_type',
          `unsupported grant_type: ${body.grant_type ?? ''}`,
        );
      }

      res.status(200).send(
        JSON.stringify({
          access_token: issued.accessToken,
          token_type: 'Bearer',
          expires_in: issued.expiresInSeconds,
          refresh_token: issued.refreshToken,
          scope: issued.scope,
        }),
      );
    } catch (err) {
      if (err instanceof OauthError) {
        // Error response per RFC 6749 section 5.2
        res.status(400).send(JSON.stringify({ error: err.code, error_description: err.message }));
        return;
      }
      throw err;
    }
  }

  /**
   * Validates request params and resolves client metadata, or renders an error
   */
  private async check(
    req: Request,
    res: Response,
    params: Record<string, string>,
  ): Promise<{ client: ClientMetadata; redirectUri: string; resource: string } | null> {
    const fail = (message: string): null => {
      sendOauthMessage(req, res, this.config, 400, message);
      return null;
    };

    if ((params.response_type ?? 'code') !== 'code') {
      return fail('Only the authorization code flow (response_type=code) is supported.');
    }
    if (params.code_challenge_method !== 'S256' || !params.code_challenge) {
      return fail(
        'Proof Key for Code Exchange is required with the S256 challenge method. ' +
          'Requests without a code_challenge or with a different method are refused.',
      );
    }
    if (!params.client_id) return fail('client_id is required.');
    if (!params.redirect_uri) return fail('redirect_uri is required.');

    let client: ClientMetadata;
    try {
      client = await resolveClientMetadata(params.client_id, this.cimdDeps ?? undefined);
    } catch (err) {
      if (err instanceof CimdError) {
        this.log.warn('client metadata document rejected', {
          client_id: params.client_id,
          error: err.message,
        });
        return fail(
          'The client metadata document could not be loaded. Check that the client_id ' +
            'URL is reachable and returns a valid JSON document.',
        );
      }
      throw err;
    }

    if (!redirectUriAllowed(params.redirect_uri, client.redirectUris)) {
      return fail('The redirect_uri is not registered for this client.');
    }

    const expected = mcpResourceIdentifier();
    if (expected === null)
      return fail(
        'The server base URL is not configured. OAuth authorization requires a declared ' +
          'base URL.',
      );
    if (params.resource && params.resource.replace(/\/+$/, '') !== expected) {
      return fail("The requested resource does not match this server's MCP resource identifier.");
    }

    return { client, redirectUri: params.redirect_uri, resource: expected };
  }
}
