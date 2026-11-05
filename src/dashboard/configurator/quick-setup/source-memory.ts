import type { RememberedFiles } from '../../../github/app-installation';
import type { GithubAppOwner } from '../../../github/app-links';
import { GithubTokenMinter } from '../../../github/tokens';

export const APP_DETAILS_MS = 60 * 60 * 1000;

export interface SourceMemory {
  minter: GithubTokenMinter;
  app: { slug: string; owner: GithubAppOwner; until: number } | null;
  repositories: Map<string, RememberedFiles>;
}

// By the fetch that reaches GitHub, because each test stubs its own
const memories = new WeakMap<typeof fetch, Map<string, SourceMemory>>();

/**
 * sourceMemory returns what the checks of a GitHub App remember between runs.
 *
 * @param api the GitHub API base
 * @param appId the App's id
 * @param privateKey the App's private key
 * @param fetchImpl how GitHub is reached
 * @param fresh whether to forget what was remembered
 */
export function sourceMemory(
  api: string,
  appId: string,
  privateKey: string,
  fetchImpl: typeof fetch,
  fresh = false,
): SourceMemory {
  const ofFetch = memories.get(fetchImpl) ?? new Map<string, SourceMemory>();
  memories.set(fetchImpl, ofFetch);
  const key = `${api} ${appId} ${privateKey}`;
  const known = fresh ? undefined : ofFetch.get(key);
  if (known) return known;
  const memory: SourceMemory = {
    minter: new GithubTokenMinter(appId, privateKey, api, fetchImpl),
    app: null,
    repositories: new Map(),
  };
  ofFetch.set(key, memory);
  return memory;
}
