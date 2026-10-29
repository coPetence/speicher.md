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
import { SignInError } from './sign-in-error';

/** GitHub OAuth login with team groups as `org/team-slug` */
@Injectable()
export class GithubAuthService {
  private readonly log: Logger = rootLogger.child('auth.github');

  constructor(
    private readonly config: ConfigService,
    private readonly fetchImpl: typeof fetch = fetch, // Injectable for tests
  ) {
    initModels();
  }

  authorizationOrigin(providerId: string): string | null {
    const provider = this.config.provider(providerId);
    if (!provider || providerType(provider) !== 'github') return null;
    return new URL(githubHosts((provider as GithubProviderConfig).base_url).web).origin;
  }

  /** Save a 10-minute login flow and build the authorization URL */
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
      // Required by LoginFlow but unused by GitHub
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
   * startInstall saves the flow an installation of a provider's App returns through. GitHub asks the person to sign in
   * with the App as they install it, and sends the browser to the sign-in callback with a code but no state; the
   * returned state goes into a cookie of this browser instead, which is what ties the return to this start.
   *
   * @param tenantId the tenant the provider belongs to
   * @param providerId the provider whose App is installed
   * @param redirectTo where the browser lands once the installation is back
   * @param options whether the person installing is named the first administrator
   */
  async startInstall(
    tenantId: string,
    providerId: string,
    redirectTo: string,
    options: { namesFirstAdmin?: boolean } = {},
  ): Promise<string> {
    this.githubProvider(providerId);
    const state = mintToken(24);
    await LoginFlow.create({
      tenant_id: tenantId,
      // Marked, so the state of an installation never completes an ordinary sign-in
      provider: `${INSTALL_MARK}${providerId}`,
      state,
      nonce: mintToken(24),
      code_verifier: mintToken(24),
      redirect_to: safeRedirect(redirectTo),
      names_first_admin: options.namesFirstAdmin === true,
      expires_at: new Date(Date.now() + FLOW_TTL_MS),
    });
    return state;
  }

  /**
   * completeInstall finishes an installation's return. A flow that names no first administrator only leads back:
   * the person is already signed in, and the code is not used. One that does signs the person in, once GitHub shows
   * that they can see the installation it named, on the account the App belongs to.
   *
   * @param tenantId the tenant
   * @param code the code GitHub sent along, or undefined
   * @param state the state from the cookie the start set
   * @param installation what GitHub said happened: the installation's id and the setup action
   * @param redirectUri the callback, which the code was issued for
   */
  async completeInstall(
    tenantId: string,
    code: string | undefined,
    state: string,
    installation: { id?: string; action: string },
    redirectUri: string,
  ): Promise<{ kind: 'forward'; redirectTo: string } | { kind: 'login'; login: CompletedLogin }> {
    const flow = await LoginFlow.findOne({ where: { tenant_id: tenantId, state } });
    if (!flow || !flow.provider.startsWith(INSTALL_MARK)) {
      throw new SignInError(
        'signin.unknown-state',
        'Installation request not found or already used.',
      );
    }
    await LoginFlow.destroy({ where: { id: flow.id } });
    if (flow.expires_at.getTime() < Date.now()) {
      throw new SignInError('signin.flow-expired', 'Installation expired. Install the App again.');
    }

    const back = new URLSearchParams({ setup_action: installation.action });
    if (installation.id) back.set('installation_id', installation.id);
    if (!flow.names_first_admin || !code || !installation.id) {
      return { kind: 'forward', redirectTo: `${flow.redirect_to}?${back}` };
    }

    const providerId = flow.provider.slice(INSTALL_MARK.length);
    const provider = this.githubProvider(providerId);
    const { web, api } = githubHosts(provider.base_url);
    // GitHub started this authorization itself, with no PKCE challenge to answer
    const token = await this.exchange(web, provider, code, redirectUri, null);
    await this.seesInstallation(api, token, installation.id, provider);

    const user = await this.api<GithubUser>(api, token, '/user');
    const subject = typeof user.id === 'number' ? String(user.id) : '';
    if (subject === '')
      throw new SignInError('signin.subject-missing', 'GitHub returned no user ID.');
    back.set('first_admin', '1');
    return {
      kind: 'login',
      login: {
        identity: {
          provider: providerId,
          subject,
          email: await this.verifiedEmail(api, token, providerId),
          displayName: user.name ?? user.login ?? null,
        },
        rawGroupIds: await this.teams(api, token, providerId),
        redirectTo: `${flow.redirect_to}?${back}`,
        namesFirstAdmin: true,
      },
    };
  }

  /**
   * seesInstallation refuses unless the person can see the installation GitHub named, and it is on the account the
   * provider's App belongs to. A code from somebody else's installation, sent to this browser, names nobody.
   */
  private async seesInstallation(
    api: string,
    token: string,
    installationId: string,
    provider: GithubProviderConfig,
  ): Promise<void> {
    const owner = provider.app?.owner_account.toLowerCase();
    for (let page = 1; page <= MAX_TEAM_PAGES; page += 1) {
      const batch = await this.api<{ installations?: GithubInstallation[] }>(
        api,
        token,
        `/user/installations?per_page=${PAGE_SIZE}&page=${page}`,
      );
      const installations = batch.installations ?? [];
      const found = installations.find((each) => String(each.id) === installationId);
      if (found) {
        if (owner === undefined || found.account?.login?.toLowerCase() === owner) return;
        break;
      }
      if (installations.length < PAGE_SIZE) break;
    }
    throw new SignInError(
      'signin.installation-unseen',
      'The installation GitHub named is not one the person signing in can see on the account of the App.',
    );
  }

  /** Exchange the code and fetch identity and teams */
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
      throw new SignInError('signin.flow-expired', 'Sign-in expired. Start sign-in again.');

    const providerId = flow.provider;
    const provider = this.githubProvider(providerId);
    const { web, api } = githubHosts(provider.base_url);

    const token = await this.exchange(web, provider, code, redirectUri, flow.code_verifier);
    const user = await this.api<GithubUser>(api, token, '/user');
    const subject = typeof user.id === 'number' ? String(user.id) : '';
    if (subject === '')
      throw new SignInError('signin.subject-missing', 'GitHub returned no user ID.');

    const identity: CallerIdentity = {
      provider: providerId,
      subject,
      email: await this.verifiedEmail(api, token, providerId),
      displayName: user.name ?? user.login ?? null,
    };

    const rawGroupIds = await this.teams(api, token, providerId);
    if (rawGroupIds.length === 0) {
      this.log.error(
        'No GitHub teams returned. Check team memberships and app access: GitHub App needs "Members: Read-only"; OAuth App needs read:org and organization approval under Settings > Third-party Access.',
        { provider: providerId },
      );
    }

    this.log.info('Sign-in completed', { provider: providerId, groups: rawGroupIds.length });
    return {
      identity,
      rawGroupIds,
      redirectTo: flow.redirect_to,
      namesFirstAdmin: flow.names_first_admin === true,
    };
  }

  /** Configured session TTL, defaulting to 8 hours */
  sessionTtlMs(providerId: string): number {
    const provider = this.config.provider(providerId);
    return parseDurationWithFallback(
      (provider as GithubProviderConfig | undefined)?.session_ttl,
      '8h',
    );
  }

  /** Exchange the authorization code for an access token */
  private async exchange(
    web: string,
    provider: GithubProviderConfig,
    code: string,
    redirectUri: string,
    codeVerifier: string | null,
  ): Promise<string> {
    const body = new URLSearchParams({
      client_id: provider.client_id,
      code,
      redirect_uri: redirectUri,
    });
    if (codeVerifier !== null) body.set('code_verifier', codeVerifier);
    if (provider.client_secret) body.set('client_secret', provider.client_secret);

    const response = await this.fetchImpl(`${web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    if (!response.ok)
      throw new SignInError(
        'signin.token-exchange-failed',
        `GitHub token request failed (HTTP ${response.status}).`,
        response.status,
      );

    // GitHub can return HTTP 200 with an error
    const tokens = (await response.json()) as TokenResponse;
    if (tokens.error) {
      throw new SignInError(
        'signin.token-exchange-refused',
        `GitHub rejected the token request: ${tokens.error_description ?? tokens.error}`,
      );
    }
    if (!tokens.access_token)
      throw new SignInError('signin.token-missing', 'GitHub returned no access token.');
    return tokens.access_token;
  }

  /** Return the primary verified email or null */
  private async verifiedEmail(
    api: string,
    token: string,
    providerId: string,
  ): Promise<string | null> {
    let addresses: GithubEmail[];
    try {
      addresses = await this.api<GithubEmail[]>(api, token, '/user/emails');
    } catch (err) {
      // Email access may be denied or revoked
      this.log.warn(
        'Cannot read GitHub email addresses. Allow user:email for OAuth Apps or "Email: Read-only" account permission for GitHub Apps.',
        { provider: providerId, error: (err as Error).message },
      );
      return null;
    }

    const primary = addresses.find((entry) => entry.primary === true && entry.verified === true);
    return primary ? primary.email.toLowerCase() : null;
  }

  /** Fetch team memberships as `org/team-slug` */
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
        this.log.warn('GitHub team page limit reached. Additional teams may be missing.', {
          provider: providerId,
          pages: MAX_TEAM_PAGES,
        });
      }
    }

    return out;
  }

  /** Call the GitHub API with the user's token */
  private async api<T>(apiBase: string, token: string, path: string): Promise<T> {
    const response = await this.fetchImpl(`${apiBase}${path}`, {
      headers: githubHeaders(token),
    });
    if (!response.ok) {
      throw new SignInError(
        'signin.api-failed',
        `GitHub request failed: ${path} (HTTP ${response.status} ${response.statusText}).`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  private githubProvider(providerId: string): GithubProviderConfig {
    const provider = this.config.provider(providerId);
    if (!provider || providerType(provider) !== 'github') {
      throw new SignInError(
        'signin.wrong-provider',
        `GitHub provider "${providerId}" is missing or has the wrong type.`,
      );
    }
    return provider as GithubProviderConfig;
  }
}

/** Scopes for team memberships and verified email */
const SCOPES = 'read:org user:email';

export const FLOW_TTL_MS = 10 * 60_000;

// Holds the state of an installation's flow, which GitHub does not hand back
export const GITHUB_INSTALL_COOKIE = 'speicher_github_install';

const INSTALL_MARK = 'github-install:';

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

interface GithubInstallation {
  id?: number;
  account?: { login?: string };
}

interface GithubTeam {
  slug?: string;
  organization?: { login?: string };
}
