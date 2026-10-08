/**
 * Session management for browser clients
 *
 * Sessions use a single cookie holding a random token, stored hashed in the DB
 * The DB row holds the provider identity, groups snapshot, and expiration
 *
 * Session TTL depends on the provider: magic-link sessions default to 30d, others
 * to 8h, overridable via the provider's session_ttl config key
 *
 * A "setup" session is a temporary session created during initial tenant setup;
 * it has a synthetic provider and no user identity
 */

import { Injectable } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { Op } from 'sequelize';

import { CallerIdentity } from '../authz/caller';
import { parseDurationWithFallback } from '../common/time';
import { env } from '../common/env';
import { SETUP_PROVIDER } from '../common/principals';
import { ConfigService } from '../config/config.service';
import { providerType } from '../config/types';
import { Session, initModels } from '../db/models';
import { hashToken, mintToken } from './tokens';

export const SESSION_COOKIE = 'speicher_session';

@Injectable()
export class SessionService {
  constructor(private readonly config: ConfigService) {
    initModels();
  }

  cookieOptions(maxAgeMs: number): CookieOptions {
    return {
      httpOnly: true,
      // SPEICHER_INSECURE_COOKIES disables secure flag for local dev over HTTP
      secure: !env('SPEICHER_INSECURE_COOKIES'),
      sameSite: 'lax',
      path: '/',
      maxAge: maxAgeMs,
    };
  }

  sessionTtlMs(providerId: string): number {
    const provider = this.config.provider(providerId);
    if (!provider) return parseDurationWithFallback(undefined, '8h');
    const kind = providerType(provider);
    if (kind === 'magic-link') {
      return parseDurationWithFallback((provider as { session_ttl?: string }).session_ttl, '30d');
    }
    // Standard providers default to 8h, shorter than magic-link which has no
    // recurring auth prompt
    return parseDurationWithFallback((provider as { session_ttl?: string }).session_ttl, '8h');
  }

  async create(
    tenantId: string,
    identity: CallerIdentity,
    rawGroupIds: string[],
    res: Response,
    options: { isSetup?: boolean } = {},
  ): Promise<string> {
    const token = mintToken();
    const ttl = this.sessionTtlMs(identity.provider);
    await Session.create({
      tenant_id: tenantId,
      token_hash: hashToken(token),
      provider: identity.provider,
      subject: identity.subject,
      email: identity.email?.toLowerCase() ?? null, // TODO why is this lowercased
      display_name: identity.displayName ?? null,
      raw_group_ids: rawGroupIds,
      groups_fetched_at: new Date(),
      is_setup: options.isSetup === true,
      expires_at: new Date(Date.now() + ttl),
    });
    res.cookie(SESSION_COOKIE, token, this.cookieOptions(ttl));
    return token;
  }

  async createSetupSession(tenantId: string, code: string, res: Response): Promise<string> {
    return this.create(
      tenantId,
      {
        provider: SETUP_PROVIDER,
        subject: code,
        email: null,
        displayName: 'Setup',
      },
      [],
      res,
      { isSetup: true },
    );
  }

  async read(req: Request): Promise<{
    identity: CallerIdentity;
    rawGroupIds: string[];
    isSetup: boolean;
  } | null> {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length === 0) return null;

    const row = await Session.findOne({
      where: {
        token_hash: hashToken(token),
        expires_at: { [Op.gt]: new Date() },
      },
    });
    if (!row) return null;

    return {
      identity: {
        provider: row.provider,
        subject: row.subject,
        email: row.email,
        displayName: row.display_name,
      },
      rawGroupIds: row.raw_group_ids ?? [],
      isSetup: row.is_setup === true,
    };
  }

  async destroy(req: Request, res: Response): Promise<void> {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && token.length > 0) {
      await Session.destroy({ where: { token_hash: hashToken(token) } });
    }
    res.clearCookie(SESSION_COOKIE, {
      ...this.cookieOptions(0),
      maxAge: undefined,
    });
  }

  async purgeExpired(): Promise<number> {
    return Session.destroy({ where: { expires_at: { [Op.lt]: new Date() } } });
  }
}
