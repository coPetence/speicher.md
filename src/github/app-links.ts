/** GitHub App settings and installation links */

import { githubHeaders } from './api';
import { GITHUB_WEB } from './hosts';
import { GithubTokenMinter } from './tokens';
import { CodedError } from '../common/errors';

/** App lookup error with GitHub's HTTP status, if available */
export class GithubAppLookupError extends CodedError<
  'github.app-lookup-failed' | 'github.app-incomplete'
> {
  constructor(
    code: 'github.app-lookup-failed' | 'github.app-incomplete',
    message: string,
    readonly status: number | null = null,
  ) {
    super(code, message);
  }
}

const LOOKUP_TIMEOUT_MS = 5000;

export const GITHUB_APP_LOOKUP_FETCH = Symbol('GITHUB_APP_LOOKUP_FETCH');

export interface GithubAppOwner {
  accountName: string;
  isOrganization: boolean;
}

export interface GithubAppLinks {
  settingsUrl: string;
  installUrl: string;
}

/** Build an App's settings and installation URLs */
export function githubAppLinks(web: string, slug: string, owner: GithubAppOwner): GithubAppLinks {
  const app = encodeURIComponent(slug);
  const settings = owner.isOrganization
    ? `/organizations/${encodeURIComponent(owner.accountName)}/settings/apps/${app}`
    : `/settings/apps/${app}`;
  // Enterprise Server uses /github-apps instead of /apps
  const page = web === GITHUB_WEB ? `/apps/${app}` : `/github-apps/${app}`;
  return { settingsUrl: `${web}${settings}`, installUrl: `${web}${page}/installations/new` };
}

/** Fetch the App's slug and owner via GET /app using an App JWT */
export async function lookupGithubApp(
  api: string,
  appId: string,
  privateKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ slug: string; owner: GithubAppOwner }> {
  const jwt = await new GithubTokenMinter(appId, privateKey, api, fetchImpl).appJwt();
  const response = await fetchImpl(`${api}/app`, {
    headers: githubHeaders(jwt),
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new GithubAppLookupError(
      'github.app-lookup-failed',
      `GitHub App lookup failed: ${response.status} ${response.statusText}`,
      response.status,
    );
  }

  const app = (await response.json()) as {
    slug?: unknown;
    owner?: { login?: unknown; type?: unknown } | null;
  };
  if (typeof app.slug !== 'string' || typeof app.owner?.login !== 'string') {
    throw new GithubAppLookupError(
      'github.app-incomplete',
      'GitHub App response is missing a valid slug or owner login.',
    );
  }
  return {
    slug: app.slug,
    owner: { accountName: app.owner.login, isOrganization: app.owner.type === 'Organization' },
  };
}
