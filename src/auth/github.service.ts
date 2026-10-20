import { Injectable } from '@nestjs/common';

import { CallerIdentity } from '../authz/caller';
import { Logger, rootLogger } from '../common/logger';
import { parseDurationWithFallback } from '../common/time';
import { ConfigService } from '../config/config.service';
import { GithubProviderConfig, providerType } from '../config/types';
import { LoginFlow, initModels } from '../db/models';
import { githubHeaders } from '../github/api';
import { githubHosts } from '../github/hosts';
import { CompletedLogin } from './login-result';
import { safeRedirect } from './oidc.service';
import { mintPkce, mintToken } from './tokens';

/**
 * GitHub authorization-code login
 *
 * Groups are GitHub org team memberships like this`org/team-slug`
 */
@Injectable()
export class GithubAuthService {
  private readonly log: Logger = rootLogger.child('auth.github');

  constructor(
    private readonly config: ConfigService,
    private readonly fetchImpl: typeof fetch = fetch, // Overridable for tests
  ) {
    initModels();
  }

  authorizationOrigin(providerId: string): string | null {
    const provider = this.config.provider(providerId);
    if (!provider || providerType(provider) !== 'github') return null;
    return new URL(githubHosts((provider as GithubProviderConfig).base_url).web).origin;
  }

  /**
   * Build a GitHub authorization URL and save the login flow
   *
   * Stores state and the redirect target in LoginFlow, expiring in 10 minutes
   */
  async authorizationUrl(
    tenantId: string,
    providerId: string,
    redirectUri: string,
    redirectTo = '/',
    options: { namesFirstAdmin?: boolean } = {},
  ): Promise<string> {
    const provider = this.githubProvider(providerId);
    const state = mintToken(24);
    const { verifier, challenge } = mintPkce();

    await LoginFlow.create({
      tenant_id: tenantId,
      provider: providerId,
      state,
      /*
        GitHub issues no id_token, so a nonce has no effect here; 
        our login flow require a nonce for other idp types, 
        therefore we mint a nonce here but do not send it.
      */
      nonce: mintToken(24),
      code_verifier: verifier,
      redirect_to: safeRedirect(redirectTo),
      names_first_admin: options.namesFirstAdmin === true,
      expires_at: new Date(Date.now() + FLOW_TTL_MS),
    });

    const url = new URL(`${githubHosts(provider.base_url).web}/login/oauth/authorize`);
    url.searchParams.set('client_id', provider.client_id);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'true');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /**
   * Exchange the code for a token and read identity and teams with it
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
    const provider = this.githubProvider(providerId);
    const { web, api } = githubHosts(provider.base_url);

    const token = await this.exchange(web, provider, code, redirectUri, flow.code_verifier);
    const user = await this.api<GithubUser>(api, token, '/user');
    const subject = typeof user.id === 'number' ? String(user.id) : '';
    if (subject === '') throw new Error('the GitHub user response carried no id');

    const identity: CallerIdentity = {
      provider: providerId,
      subject,
      email: await this.verifiedEmail(api, token, providerId),
      displayName: user.name ?? user.login ?? null,
    };

    const rawGroupIds = await this.teams(api, token, providerId);
    if (rawGroupIds.length === 0) {
      this.log.error(
        'no team memberships were included in the sign-in response. This can happen if the app has no access to team memberships. If you configured a GitHub App check if the organisation permissions `Members: Read-only` is set. If you use an OAuth App make sure access is permitted in the organizations setings under Settings -> Third-party Access, `read:org`' +
          { provider: providerId },
      );
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
      (provider as GithubProviderConfig | undefined)?.session_ttl,
      '8h',
    );
  }

  /**
   * POST the code to GitHub and return the access token
   */
  private async exchange(
    web: string,
    provider: GithubProviderConfig,
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<string> {
    const body = new URLSearchParams({
      client_id: provider.client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    if (provider.client_secret) body.set('client_secret', provider.client_secret);

    const response = await this.fetchImpl(`${web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    if (!response.ok) throw new Error(`token exchange failed: ${response.status}`);

    // A refused code comes back 200 with an `error`
    const tokens = (await response.json()) as TokenResponse;
    if (tokens.error) {
      throw new Error(`token exchange refused: ${tokens.error_description ?? tokens.error}`);
    }
    if (!tokens.access_token) throw new Error('no access_token in the token response');
    return tokens.access_token;
  }

  /**
   * Primary verified email address (or null)
   */
  private async verifiedEmail(
    api: string,
    token: string,
    providerId: string,
  ): Promise<string | null> {
    let addresses: GithubEmail[];
    try {
      addresses = await this.api<GithubEmail[]>(api, token, '/user/emails');
    } catch (err) {
      // Reached when `user:email` was refused at consent or revoked since
      this.log.warn(
        'could not read the email address list. Make sure the user:email scope is permitted. If its a GitHub App make sure to permit the Account Permission: Email = Read Only',
        { provider: providerId, error: (err as Error).message },
      );
      return null;
    }

    const primary = addresses.find((entry) => entry.primary === true && entry.verified === true);
    return primary ? primary.email.toLowerCase() : null;
  }

  /**
   * Team memberships as `org/team-slug`
   */
  private async teams(api: string, token: string, providerId: string): Promise<string[]> {
    const out: string[] = [];

    for (let page = 1; page <= MAX_TEAM_PAGES; page += 1) {
      const batch = await this.api<GithubTeam[]>(
        api,
        token,
        `/user/teams?per_page=${PAGE_SIZE}&page=${page}`,
      );
      for (const team of batch) {
        const org = team.organization?.login;
        if (org && team.slug) out.push(`${org}/${team.slug}`);
      }
      if (batch.length < PAGE_SIZE) return out;

      if (page === MAX_TEAM_PAGES) {
        this.log.warn(
          'stopped reading teams because user is in to many teams. some teams were dropped',
          {
            provider: providerId,
            pages: MAX_TEAM_PAGES,
          },
        );
      }
    }

    return out;
  }

  /** Authenticated REST call against the user's own token */
  private async api<T>(apiBase: string, token: string, path: string): Promise<T> {
    const response = await this.fetchImpl(`${apiBase}${path}`, {
      headers: githubHeaders(token),
    });
    if (!response.ok) {
      throw new Error(`GitHub ${path} -> ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  }

  private githubProvider(providerId: string): GithubProviderConfig {
    const provider = this.config.provider(providerId);
    if (!provider || providerType(provider) !== 'github') {
      throw new Error(`"${providerId}" is not a github provider`);
    }
    return provider as GithubProviderConfig;
  }
}

/**
 * `read:org` carries team membership, `user:email` the verified address
 */
const SCOPES = 'read:org user:email';

export const FLOW_TTL_MS = 10 * 60_000;

const PAGE_SIZE = 100;
const MAX_TEAM_PAGES = 10;

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GithubUser {
  id?: number;
  login?: string;
  name?: string | null;
}

interface GithubEmail {
  email: string;
  primary?: boolean;
  verified?: boolean;
}

interface GithubTeam {
  slug?: string;
  organization?: { login?: string };
}
