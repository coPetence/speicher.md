/** What an App's installation on an account gives it access to */

import { githubHeaders, githubRequest, refusedRequest } from './api';
import { GithubTokenMinter } from './tokens';

const LOOKUP_TIMEOUT_MS = 5000;
// Listing every file of a large repository takes GitHub longer than one answer
const TREE_TIMEOUT_MS = 15000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export interface InstallationAccess {
  installationId: string;
  // Whether the installation reads every repository of the account, or the ones picked for it
  selection: 'all' | 'selected';
  // How many repositories it can read
  repositories: number;
}

/**
 * installationAccess returns what the installation of an App on an account can read, or null when the App is not
 * installed there.
 *
 * @param api the GitHub API base
 * @param appId the App's id
 * @param privateKey the App's private key
 * @param account the account the App is installed on
 * @param fetchImpl how GitHub is reached
 */
export async function installationAccess(
  api: string,
  appId: string,
  privateKey: string,
  account: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InstallationAccess | null> {
  const installation = await installationOn(api, appId, privateKey, account, fetchImpl);
  if (!installation) return null;
  // One repository per page is enough: the count comes with it
  const listed = await get<{ total_count?: number }>(
    fetchImpl,
    `${api}/installation/repositories?per_page=1`,
    installation.token,
  );
  return {
    installationId: installation.installationId,
    selection: installation.selection,
    repositories: listed.total_count ?? 0,
  };
}

/**
 * installationOn returns the installation of an App on an account, with a token that reads what it can, or null when
 * the App is not installed there.
 *
 * @param api the GitHub API base
 * @param appId the App's id
 * @param privateKey the App's private key
 * @param account the account the App is installed on
 * @param fetchImpl how GitHub is reached
 */
export async function installationOn(
  api: string,
  appId: string,
  privateKey: string,
  account: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ installationId: string; selection: 'all' | 'selected'; token: string } | null> {
  const minter = new GithubTokenMinter(appId, privateKey, api, fetchImpl);
  const jwt = await minter.appJwt();

  let found: { id?: number; repository_selection?: string } | undefined;
  for (let page = 1; page <= MAX_PAGES && !found; page += 1) {
    const batch = await get<
      { id?: number; account?: { login?: string }; repository_selection?: string }[]
    >(fetchImpl, `${api}/app/installations?per_page=${PAGE_SIZE}&page=${page}`, jwt);
    found = batch.find((each) => each.account?.login?.toLowerCase() === account.toLowerCase());
    if (batch.length < PAGE_SIZE) break;
  }
  if (typeof found?.id !== 'number') return null;

  const installationId = String(found.id);
  return {
    installationId,
    selection: found.repository_selection === 'selected' ? 'selected' : 'all',
    token: await minter.installationToken(installationId),
  };
}

/** A repository an installation reads, with its `.speicher.yaml` files */
export interface RepositoryFiles {
  // e.g. `acme/handbook`
  fullName: string;
  defaultBranch: string;
  // null when GitHub could not be asked for them
  files: { path: string; raw: string }[] | null;
  // Why GitHub could not be asked, when it could not
  error?: string;
  // Whether there were more files than were read
  truncated: boolean;
}

/**
 * repositoryConfigs reads the `.speicher.yaml` files of the repositories an installation can read, as they are on
 * each repository's default branch.
 *
 * @param api the GitHub API base
 * @param token an installation token
 * @param isConfigPath which paths are `.speicher.yaml` files
 * @param fetchImpl how GitHub is reached
 * @param limits how many repositories, and files of each, are read at most
 */
export async function repositoryConfigs(
  api: string,
  token: string,
  isConfigPath: (path: string) => boolean,
  fetchImpl: typeof fetch = fetch,
  limits = { repositories: PAGE_SIZE, files: 50 },
): Promise<{ repositories: RepositoryFiles[]; more: boolean }> {
  const listed = await get<{
    total_count?: number;
    repositories?: { full_name?: string; default_branch?: string }[];
  }>(fetchImpl, `${api}/installation/repositories?per_page=${limits.repositories}`, token);
  const repositories = (listed.repositories ?? []).filter(
    (repo): repo is { full_name: string; default_branch?: string } =>
      typeof repo.full_name === 'string',
  );

  const read = await inBatches(repositories, 5, async (repo) => {
    const branch = repo.default_branch ?? 'main';
    try {
      const paths = await treePaths(api, token, repo.full_name, branch, fetchImpl);
      const configs = paths.filter(isConfigPath);
      const files = await Promise.all(
        configs.slice(0, limits.files).map(async (path) => ({
          path,
          raw: await rawFile(api, token, repo.full_name, path, branch, fetchImpl),
        })),
      );
      return {
        fullName: repo.full_name,
        defaultBranch: branch,
        files,
        truncated: configs.length > limits.files,
      };
    } catch (err) {
      return {
        fullName: repo.full_name,
        defaultBranch: branch,
        files: null,
        truncated: false,
        error: (err as Error).message,
      };
    }
  });
  return { repositories: read, more: (listed.total_count ?? 0) > repositories.length };
}

/** The paths of a repository's files on a branch; none for a repository that has no commit yet */
async function treePaths(
  api: string,
  token: string,
  fullName: string,
  branch: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const url = `${api}/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const response = await githubRequest(fetchImpl, url, {
    headers: githubHeaders(token),
    timeoutMs: TREE_TIMEOUT_MS,
  });
  // GitHub answers 409 for a repository without commits
  if (response.status === 409) return [];
  if (!response.ok) throw refusedRequest(response, url);
  const tree = (await response.json()) as { tree?: { path?: string; type?: string }[] };
  return (tree.tree ?? [])
    .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
    .map((entry) => entry.path as string);
}

/** A file's text on a branch */
async function rawFile(
  api: string,
  token: string,
  fullName: string,
  path: string,
  branch: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const url = `${api}/repos/${fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`;
  const response = await githubRequest(fetchImpl, url, {
    headers: { ...githubHeaders(token), Accept: 'application/vnd.github.raw+json' },
    timeoutMs: LOOKUP_TIMEOUT_MS,
  });
  if (!response.ok) throw refusedRequest(response, url);
  return response.text();
}

/** Runs one call per item, a few at a time, in order */
async function inBatches<T, R>(
  items: T[],
  size: number,
  call: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let at = 0; at < items.length; at += size) {
    out.push(...(await Promise.all(items.slice(at, at + size).map(call))));
  }
  return out;
}

async function get<T>(fetchImpl: typeof fetch, url: string, token: string): Promise<T> {
  const response = await githubRequest(fetchImpl, url, {
    headers: githubHeaders(token),
    timeoutMs: LOOKUP_TIMEOUT_MS,
  });
  if (!response.ok) throw refusedRequest(response, url);
  return (await response.json()) as T;
}
