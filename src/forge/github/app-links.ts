/**
 * The links to a GitHub App's pages
 */

import { GITHUB_WEB } from './hosts';
import { GithubTokenMinter } from './tokens';

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

/**
 * githubAppLinks returns the links to the settings page and the installation page of a GitHub App.
 *
 * @param web the web address of the GitHub instance, e.g. `https://github.com`
 * @param slug the name of the App in its URLs, e.g. `speicher-md`
 * @param owner the account the App belongs to
 */
export function githubAppLinks(web: string, slug: string, owner: GithubAppOwner): GithubAppLinks {
  const app = encodeURIComponent(slug);
  const settings = owner.isOrganization
    ? `/organizations/${encodeURIComponent(owner.accountName)}/settings/apps/${app}`
    : `/settings/apps/${app}`;
  // A GitHub Enterprise Server serves an App's public page under `/github-apps`
  const page = web === GITHUB_WEB ? `/apps/${app}` : `/github-apps/${app}`;
  return { settingsUrl: `${web}${settings}`, installUrl: `${web}${page}/installations/new` };
}

/**
 * lookupGithubApp returns the slug and the owner of the GitHub App that the id and the private key belong to.
 * It asks GitHub's `GET /app`, signed as the App.
 *
 * @param api the API address of the GitHub instance
 * @param appId the App's id
 * @param privateKey the App's private key
 * @param fetchImpl the fetch to call GitHub with
 */
export async function lookupGithubApp(
  api: string,
  appId: string,
  privateKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ slug: string; owner: GithubAppOwner }> {
  const jwt = await new GithubTokenMinter(appId, privateKey, api, fetchImpl).appJwt();
  const response = await fetchImpl(`${api}/app`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub did not answer for the App: ${response.status} ${response.statusText}`);
  }

  const app = (await response.json()) as {
    slug?: unknown;
    owner?: { login?: unknown; type?: unknown } | null;
  };
  if (typeof app.slug !== 'string' || typeof app.owner?.login !== 'string') {
    throw new Error('GitHub sent the App without its slug or owner');
  }
  return {
    slug: app.slug,
    owner: { accountName: app.owner.login, isOrganization: app.owner.type === 'Organization' },
  };
}
