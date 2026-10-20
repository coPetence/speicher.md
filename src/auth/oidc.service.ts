import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { JWTPayload, createRemoteJWKSet, jwtVerify } from 'jose';

import { CallerIdentity } from '../authz/caller';
import { Logger, rootLogger } from '../common/logger';
import { parseDurationWithFallback } from '../common/time';
import { ConfigService } from '../config/config.service';
import { OidcProviderConfig, providerType } from '../config/types';
import { LoginFlow, initModels } from '../db/models';
import { CompletedLogin } from './login-result';
import { mintPkce, mintToken } from './tokens';

/**
 * OIDC authorization-code login for external identity providers
 *
 * Loads the provider's discovery document, builds the authorization URL with PKCE,
 * exchanges the code for tokens, and extracts identity and group claims from the id_token
 *
 * Uses configurable `subject_claim`, `email_claim`, `groups_claim` names
 *
 * Caches JWK Sets and discovery documents per issuer
 */
@Injectable()
export class OidcService {
  private readonly log: Logger = rootLogger.child('auth.oidc');

  private readonly jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  private readonly discovery = new Map<string, DiscoveryDocument>();

  constructor(
    private readonly config: ConfigService,
    private readonly fetchImpl: typeof fetch = fetch, // Overridable for tests
  ) {
    initModels();
  }

  authorizationOrigins(providerId: string): string[] {
    const provider = this.config.provider(providerId);
    if (!provider || providerType(provider) !== 'oidc') return [];
    const issuer = normalizeIssuer((provider as OidcProviderConfig).issuer);
    const endpoint = this.discovery.get(issuer)?.authorization_endpoint;
    return [issuer, endpoint].flatMap((url) => {
      if (!url) return [];
      try {
        return [new URL(url).origin];
      } catch {
        return [];
      }
    });
  }

  /**
   * Build an OIDC authorization URL with PKCE and save the login flow
   *
   * Stores state, nonce, code verifier and redirect target in LoginFlow, expiring 10 min
   * A login hint, the address the person typed, saves them typing it again at the provider
   */
  async authorizationUrl(
    tenantId: string,
    providerId: string,
    redirectUri: string,
    redirectTo = '/',
    options: { namesFirstAdmin?: boolean; loginHint?: string } = {},
  ): Promise<string> {
    const provider = this.oidcProvider(providerId);
    const meta = await this.discover(providerId, provider);

    const state = mintToken(24);
    const nonce = mintToken(24);

    const { verifier: codeVerifier, challenge } = mintPkce();

    await LoginFlow.create({
      tenant_id: tenantId,
      provider: providerId,
      state,
      nonce,
      code_verifier: codeVerifier,
      redirect_to: safeRedirect(redirectTo),
      names_first_admin: options.namesFirstAdmin === true,
      expires_at: new Date(Date.now() + 10 * 60_000),
    });

    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', provider.client_id);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (options.loginHint) url.searchParams.set('login_hint', options.loginHint);
    return url.toString();
  }

  /**
   * Exchange code for tokens and return identity, groups and redirect
   *
   * Destroys the LoginFlow row (single-use). Validates expiry, nonce, token signature.
   * Errors on nonce mismatch or expired flow
   */
  async completeLogin(
    tenantId: string,
    code: string,
    state: string,
    redirectUri: string,
  ): Promise<CompletedLogin> {
    const flow = await LoginFlow.findOne({ where: { tenant_id: tenantId, state } });
    if (!flow) throw new Error('unknown or reused login state');

    await LoginFlow.destroy({ where: { id: flow.id } });
    if (flow.expires_at.getTime() < Date.now()) throw new Error('login flow expired');

    const providerId = flow.provider;
    const provider = this.oidcProvider(providerId);
    const meta = await this.discover(providerId, provider);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: provider.client_id,
      code_verifier: flow.code_verifier,
    });
    if (provider.client_secret) body.set('client_secret', provider.client_secret);

    const response = await this.fetchImpl(meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) throw new Error(`token exchange failed: ${response.status}`);
    const tokens = (await response.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error('no id_token in the token response');

    const { payload } = await jwtVerify(tokens.id_token, this.keySet(meta), {
      issuer: meta.issuer,
      audience: provider.client_id,
    });
    if (payload.nonce !== flow.nonce) throw new Error('id_token nonce mismatch');

    const identity = this.identityFrom(providerId, provider, payload);
    const groupsClaim = provider.groups_claim ?? 'groups';
    const rawGroupIds = claimAsArray(payload[groupsClaim]);

    if (rawGroupIds.length === 0 && hasGroupsOverage(payload, groupsClaim)) {
      this.log.error(
        'the id_token carries a groups overage indicator instead of group ids; this ' +
          'user is in too many groups for the claim and will resolve to no groups. ' +
          'Configure a `directory` block for this provider, or scope the groups claim ' +
          'to the groups assigned to this application.',
        { provider: providerId },
      );
    }

    if (rawGroupIds.length === 0) {
      // Not necessarily an overage -- the user may have no groups
      this.log.warn('login carried no group ids', {
        provider: providerId,
        claim: groupsClaim,
        claimsPresent: Object.keys(payload).sort().join(','),
      });
    }

    this.log.info('login completed', { provider: providerId, groups: rawGroupIds.length });
    return {
      identity,
      rawGroupIds,
      redirectTo: flow.redirect_to,
      namesFirstAdmin: flow.names_first_admin === true,
    };
  }

  /**
   * Session TTL from the provider config, default 8 hours
   */
  sessionTtlMs(providerId: string): number {
    const provider = this.config.provider(providerId);
    return parseDurationWithFallback(
      (provider as OidcProviderConfig | undefined)?.session_ttl,
      '8h',
    );
  }

  /**
   * Build a CallerIdentity from the id_token payload, using configured claim names
   */
  private identityFrom(
    providerId: string,
    provider: OidcProviderConfig,
    payload: JWTPayload,
  ): CallerIdentity {
    const subjectClaim = provider.subject_claim ?? 'sub';
    const subject = payload[subjectClaim];
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new Error(`id_token has no "${subjectClaim}" claim`);
    }
    const emailClaim = provider.email_claim ?? 'email';
    const email = payload[emailClaim];
    return {
      provider: providerId,
      subject,
      email: typeof email === 'string' ? email.toLowerCase() : null,
      displayName: typeof payload.name === 'string' ? payload.name : null,
    };
  }

  private oidcProvider(providerId: string): OidcProviderConfig {
    const provider = this.config.provider(providerId);
    if (!provider || providerType(provider) !== 'oidc') {
      throw new Error(`"${providerId}" is not an oidc provider`);
    }
    return provider as OidcProviderConfig;
  }

  private keySet(meta: DiscoveryDocument) {
    let set = this.jwks.get(meta.jwks_uri);
    if (!set) {
      set = createRemoteJWKSet(new URL(meta.jwks_uri));
      this.jwks.set(meta.jwks_uri, set);
    }
    return set;
  }

  /**
   * Fetch and cache an OIDC discovery document from the issuer's well-known endpoint
   *
   * Validates the returned issuer matches the configured one
   * Not for multi-tenant issuers: the issuer URL must be pinned to a single tenant
   */
  private async discover(
    providerId: string,
    provider: OidcProviderConfig,
  ): Promise<DiscoveryDocument> {
    const issuer = normalizeIssuer(provider.issuer);
    const cached = this.discovery.get(issuer);
    if (cached) return cached;

    const url = `${issuer}/.well-known/openid-configuration`;
    const response = await this.fetchImpl(url);
    if (!response.ok)
      throw new Error(`OIDC discovery failed for ${providerId}: ${response.status}`);
    const meta = (await response.json()) as DiscoveryDocument;

    if (meta.issuer !== issuer && meta.issuer !== provider.issuer) {
      throw new Error(
        `OIDC discovery for ${providerId} returned issuer "${meta.issuer}", expected ` +
          `"${provider.issuer}".${discoveryHint(meta.issuer)}`,
      );
    }
    this.discovery.set(issuer, meta);
    return meta;
  }
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, '');
}

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/**
 * Hint when the discovered issuer differs from the configured one
 *
 * Multi-tenant (`common`, `organizations`) or v1.0 (`sts.windows.net`) issuers that
 * cannot be pinned will produce mismatches; use a tenant GUID or the v2.0 endpoint
 */
export function discoveryHint(discovered: string): string {
  // Matches the multi-tenant placeholder pattern
  if (discovered.includes('{tenantid}')) {
    return (
      ' Use your tenant GUID in the issuer URL rather than `common` or ' +
      '`organizations`: a multi-tenant issuer cannot be pinned, and pinning ' +
      'issuer, audience and key source together is what stops a token from ' +
      "one provider being accepted for another's client_id."
    );
  }
  // Matches the Entra v1.0 issuer
  if (/^https:\/\/sts\.windows\.net\//.test(discovered)) {
    return (
      " That is Entra's v1.0 metadata. Append `/v2.0` to the issuer URL " +
      '(`https://login.microsoftonline.com/<tenant>/v2.0`); v1.0 issues tokens ' +
      'under a different issuer and a different set of claim names.'
    );
  }
  return '';
}

/**
 * Check whether the id_token has a groups overage indicator via `_claim_names`
 */
export function hasGroupsOverage(payload: JWTPayload, groupsClaim: string): boolean {
  const names = payload._claim_names;
  if (!names || typeof names !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(names, groupsClaim);
}

function claimAsArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  return [];
}

/**
 * Ensure the redirect target is a relative path, not an absolute or protocol-relative URL
 */
export function safeRedirect(target: string): string {
  if (!target.startsWith('/') || target.startsWith('//')) return '/';
  return target;
}

export { randomBytes };
