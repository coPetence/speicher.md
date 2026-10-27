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
import { SignInError } from './sign-in-error';

/** OIDC code login with PKCE and cached discovery metadata and signing keys */
@Injectable()
export class OidcService {
  private readonly log: Logger = rootLogger.child('auth.oidc');

  private readonly jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  private readonly discovery = new Map<string, DiscoveryDocument>();

  constructor(
    private readonly config: ConfigService,
    private readonly fetchImpl: typeof fetch = fetch, // Injectable for tests
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

  /** Build a PKCE authorization URL and save a 10-minute login flow */
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

  /** Consume the flow, exchange the code, and validate the ID token */
  async completeLogin(
    tenantId: string,
    code: string,
    state: string,
    redirectUri: string,
  ): Promise<CompletedLogin> {
    const flow = await LoginFlow.findOne({ where: { tenant_id: tenantId, state } });
    if (!flow)
      throw new SignInError(
        'signin.unknown-state',
        'Sign-in request not found or already used. Start sign-in again.',
      );

    await LoginFlow.destroy({ where: { id: flow.id } });
    if (flow.expires_at.getTime() < Date.now())
      throw new SignInError('signin.flow-expired', 'Sign-in request expired. Start sign-in again.');

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
    if (!response.ok)
      throw new SignInError(
        'signin.token-exchange-failed',
        `Sign-in provider rejected the token exchange (HTTP ${response.status}).`,
        response.status,
      );
    const tokens = (await response.json()) as { id_token?: string };
    if (!tokens.id_token)
      throw new SignInError('signin.token-missing', 'Sign-in provider returned no ID token.');

    const { payload } = await jwtVerify(tokens.id_token, this.keySet(meta), {
      issuer: meta.issuer,
      audience: provider.client_id,
    });
    if (payload.nonce !== flow.nonce)
      throw new SignInError(
        'signin.nonce-mismatch',
        'ID token does not match this sign-in request. Start sign-in again.',
      );

    const identity = this.identityFrom(providerId, provider, payload);
    const groupsClaim = provider.groups_claim ?? 'groups';
    const rawGroupIds = claimAsArray(payload[groupsClaim]);

    if (rawGroupIds.length === 0 && hasGroupsOverage(payload, groupsClaim)) {
      this.log.error(
        'Too many groups to include in the ID token; no groups resolved. ' +
          'Configure a `directory` block or limit the groups claim to groups assigned to this application.',
        { provider: providerId },
      );
    }

    if (rawGroupIds.length === 0) {
      // No groups may mean no memberships, not overage
      this.log.warn('ID token contains no group IDs.', {
        provider: providerId,
        claim: groupsClaim,
        claimsPresent: Object.keys(payload).sort().join(','),
      });
    }

    this.log.info('Sign-in completed.', { provider: providerId, groups: rawGroupIds.length });
    return {
      identity,
      rawGroupIds,
      redirectTo: flow.redirect_to,
      namesFirstAdmin: flow.names_first_admin === true,
    };
  }

  /** Provider session TTL, defaulting to 8 hours */
  sessionTtlMs(providerId: string): number {
    const provider = this.config.provider(providerId);
    return parseDurationWithFallback(
      (provider as OidcProviderConfig | undefined)?.session_ttl,
      '8h',
    );
  }

  /** Map configured ID token claims to caller identity */
  private identityFrom(
    providerId: string,
    provider: OidcProviderConfig,
    payload: JWTPayload,
  ): CallerIdentity {
    const subjectClaim = provider.subject_claim ?? 'sub';
    const subject = payload[subjectClaim];
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new SignInError(
        'signin.subject-missing',
        `ID token claim "${subjectClaim}" is missing or is not a non-empty string.`,
      );
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
      throw new SignInError(
        'signin.wrong-provider',
        `Provider "${providerId}" is missing or is not configured for OIDC.`,
      );
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

  /** Authorization endpoint origin for CSP form-action */
  async authorizationOrigin(providerId: string): Promise<string> {
    const provider = this.oidcProvider(providerId);
    const meta = await this.discover(providerId, provider);
    return new URL(meta.authorization_endpoint).origin;
  }

  /** Fetch and cache discovery metadata, requiring a matching tenant-specific issuer */
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
      throw new SignInError(
        'signin.discovery-failed',
        `Could not load OIDC configuration for "${providerId}" (HTTP ${response.status}).`,
        response.status,
      );
    const meta = (await response.json()) as DiscoveryDocument;

    if (meta.issuer !== issuer && meta.issuer !== provider.issuer) {
      throw new SignInError(
        'signin.discovery-failed',
        `Issuer mismatch for "${providerId}": received "${meta.issuer}", expected ` +
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

/** Suggest fixes for Entra multi-tenant or v1 issuer mismatches */
export function discoveryHint(discovered: string): string {
  // Entra multi-tenant issuer
  if (discovered.includes('{tenantid}')) {
    return (
      ' Use your tenant GUID instead of `common` or `organizations` in the issuer URL. ' +
      'Multi-tenant issuers are not supported.'
    );
  }
  // Entra v1 issuer
  if (/^https:\/\/sts\.windows\.net\//.test(discovered)) {
    return (
      ' Entra v1.0 metadata returned. Use the v2.0 issuer URL: ' +
      '`https://login.microsoftonline.com/<tenant>/v2.0`.'
    );
  }
  return '';
}

/** Check `_claim_names` for groups omitted due to overage */
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

/** Allow only paths starting with a single slash */
export function safeRedirect(target: string): string {
  if (!target.startsWith('/') || target.startsWith('//')) return '/';
  return target;
}

export { randomBytes };
