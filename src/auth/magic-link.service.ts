/**
 * Issue and redeem one-time sign-in tokens sent via email
 *
 * The 32-byte token is hashed before storage; the raw value appears only in
 * the link
 * Optionally bound to the requesting browser
 * Silently skipped when rate-limited (five per 15-minute window per address)
 * or when the address has no grant on any document or repo
 *
 * Not: checking for admin grants that use a wildcard principal (reason removed;
 * write one)
 */

import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Op, QueryTypes } from 'sequelize';

import { parseDurationWithFallback } from '../common/time';
import { Logger, rootLogger } from '../common/logger';
import { emailPrincipal, groupPrincipal, subjectPrincipal } from '../common/principals';
import { ConfigService } from '../config/config.service';
import { MagicLinkProviderConfig, providerType } from '../config/types';
import { MagicLinkToken, initModels } from '../db/models';
import { getSequelize } from '../db/sequelize';
import { Mailer } from '../notify/mailer';
import { CompletedLogin } from './login-result';
import { safeRedirect } from './oidc.service';
import { hashToken, mintToken, safeEqual } from './tokens';

@Injectable()
export class MagicLinkService {
  private readonly log: Logger = rootLogger.child('auth.magic-link');

  constructor(
    private readonly config: ConfigService,
    private readonly mailer: Mailer,
  ) {
    initModels();
  }

  /**
   * Create a token and send it by email, or silently skip
   *
   * Silently skips if the address is rate-limited or has no ACL entry
   * The caller gets no feedback about which case occurred
   */
  async request(
    tenantId: string,
    providerId: string,
    email: string,
    origin: string,
    browserBinding: string | null,
    redirectTo = '/',
    options: { namesFirstAdmin?: boolean } = {},
  ): Promise<void> {
    const namesFirstAdmin = options.namesFirstAdmin === true;
    const address = email.trim().toLowerCase();
    const provider = this.magicProvider(providerId);

    if (!(await this.rateLimitOk(tenantId, address))) {
      this.log.warn('magic-link request rate limited');
      return;
    }

    if (!namesFirstAdmin && !(await this.addressAppearsInSomeAcl(tenantId, providerId, address))) {
      this.log.info('magic-link requested for an address with no grant; nothing sent');
      return;
    }

    const token = mintToken(32);
    const ttl = parseDurationWithFallback(provider.token_ttl, '15m');
    await MagicLinkToken.create({
      tenant_id: tenantId,
      provider: providerId,
      email: address,
      token_hash: hashToken(token),
      browser_binding:
        provider.same_browser !== false && browserBinding ? hashToken(browserBinding) : null,
      redirect_to: safeRedirect(redirectTo),
      names_first_admin: namesFirstAdmin,
      expires_at: new Date(Date.now() + ttl),
    });

    const link = `${origin}/api/auth/magic/callback?token=${encodeURIComponent(token)}`;
    const expiry = `This link expires in ${provider.token_ttl ?? '15m'} and can be used once.\n`;
    if (namesFirstAdmin) {
      await this.mailer.send(
        address,
        'Become the Speicher administrator',
        `Sign in to become the first administrator of this instance: ${link}\n\n` +
          `Open it in the browser you set up the instance in. ${expiry}`,
      );
      return;
    }
    await this.mailer.send(address, 'Your Speicher sign-in link', `Sign in: ${link}\n\n${expiry}`);
  }

  /**
   * Consume a token and return the completed login, or null
   *
   * Refused when the optional browser binding does not match
   */
  async redeem(
    tenantId: string,
    token: string,
    browserBinding: string | null,
  ): Promise<CompletedLogin | null> {
    const row = await MagicLinkToken.findOne({
      where: {
        tenant_id: tenantId,
        token_hash: hashToken(token),
        consumed_at: { [Op.is]: null },
        expires_at: { [Op.gt]: new Date() },
      },
    });
    if (!row) return null;

    await MagicLinkToken.update({ consumed_at: new Date() }, { where: { id: row.id } });

    if (row.browser_binding) {
      // The stored binding is a hash; compare with a constant-time function
      if (!browserBinding || !safeEqual(row.browser_binding, hashToken(browserBinding))) {
        this.log.warn('magic link redeemed from a different browser; refused');
        return null;
      }
    }

    return {
      identity: {
        provider: row.provider,
        subject: row.email,
        email: row.email,
        displayName: row.email,
      },
      rawGroupIds: [],
      redirectTo: safeRedirect(row.redirect_to ?? '/'),
      namesFirstAdmin: row.names_first_admin === true,
    };
  }

  /**
   * True when the address appears in at least one ACL or admin list
   *
   * Checks document effective_principals and repo maintainer_principals,
   * also resolves groups that reference the address
   */
  private async addressAppearsInSomeAcl(
    tenantId: string,
    providerId: string,
    address: string,
  ): Promise<boolean> {
    const candidates = [subjectPrincipal(providerId, address), emailPrincipal(providerId, address)];

    for (const name of this.config.resolveInternalGroups(providerId, [], {
      subject: address,
      email: address,
    })) {
      candidates.push(groupPrincipal(name));
    }

    const rows = await getSequelize().query<{ found: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM documents
          WHERE tenant_id = :tenantId AND effective_principals && CAST(:candidates AS text[])
       ) OR EXISTS (
         SELECT 1 FROM repos
          WHERE tenant_id = :tenantId AND maintainer_principals && CAST(:candidates AS text[])
       ) AS found`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId,
          candidates: `{${candidates.map((c) => `"${c}"`).join(',')}}`,
        },
      },
    );
    if (rows[0]?.found) return true;

    return this.config.adminPrincipals().some((p) => candidates.includes(p));
  }

  /**
   * True when fewer than five requests were made from this address this window
   *
   * Window is rounded to 15-minute blocks (900_000 ms)
   */
  private async rateLimitOk(tenantId: string, address: string): Promise<boolean> {
    const bucket = `magic:${tenantId}:${createHash('sha256').update(address).digest('hex')}`;
    const windowStart = new Date(Math.floor(Date.now() / 900_000) * 900_000);
    const rows = await getSequelize().query<{ count: number }>(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (:bucket, :windowStart, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
       RETURNING count`,
      { type: QueryTypes.SELECT, replacements: { bucket, windowStart } },
    );
    return (rows[0]?.count ?? 0) <= 5;
  }

  /**
   * Return the provider config, or throw if it is not a magic-link provider
   */
  private magicProvider(providerId: string): MagicLinkProviderConfig {
    const provider = this.config.provider(providerId);
    if (!provider || providerType(provider) !== 'magic-link') {
      throw new Error(`"${providerId}" is not a magic-link provider`);
    }
    return provider as MagicLinkProviderConfig;
  }
}
