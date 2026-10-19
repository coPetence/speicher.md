/**
 * GitHub API driver for Speicher
 *
 * Authenticates as a GitHub App, issuing JWTs for the app and tokens per installation
 * Rate-limited per installation via `RateLimiter`
 *
 * Not using Octokit to keep dependencies minimal and control token lifecycle explicitly
 */

import { join } from 'node:path';

import { Logger, rootLogger } from '../../common/logger';
import { ForgeConfig } from '../../config/types';
import { githubHeaders } from '../../github/api';
import { githubHosts } from '../../github/hosts';
import { GithubTokenMinter } from '../../github/tokens';
import { isConfigFilename } from '../../ingest/paths';
import type { WebhookVerification } from '../../webhooks/signed-delivery';
import { ForgeAction, ForgeDriver, RemoteInstallation, RemoteRepo } from '../driver';
import { checkoutTree, ensureMirror, resolveHead as gitResolveHead } from '../git';
import { RateLimiter } from '../rate-limit';
import { mapGithubEvent, verifyGithubSignature } from './webhook';

export class GithubDriver implements ForgeDriver {
  readonly type = 'github' as const;
  readonly acceptsWebhooks = true;
  readonly hasInstallations = true;
  private readonly log: Logger = rootLogger.child('forge.github');
  private readonly minter: GithubTokenMinter;
  private readonly limiter = new RateLimiter();
  private readonly apiBase: string;

  constructor(
    readonly key: string,
    private readonly config: ForgeConfig,
    private readonly trackedBranchOf: (forgeRepoId: string) => string | undefined = () => undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.apiBase = githubHosts(config.base_url).api;
    this.minter = new GithubTokenMinter(
      config.app_id ?? '',
      config.private_key ?? '',
      this.apiBase,
      fetchImpl,
    );
  }

  /** Validate signature on the incoming webhook request */
  verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): WebhookVerification {
    return verifyGithubSignature(headers, rawBody, this.config.webhook_secret ?? '');
  }

  /** Translate a GitHub webhook event into internal forge actions */
  mapEvent(event: string, payload: Record<string, unknown>): ForgeAction[] {
    return mapGithubEvent(event, payload, this.trackedBranchOf);
  }

  /** All installations the app is on, paginated 100 at a time */
  async listInstallations(): Promise<RemoteInstallation[]> {
    const installations: RemoteInstallation[] = [];
    let page = 1;
    for (;;) {
      const batch = await this.appApi<GithubInstallationPayload[]>(
        `/app/installations?per_page=100&page=${page}`,
      );
      for (const installation of batch) {
        installations.push({
          installationId: String(installation.id),
          namespace: installation.account?.login ?? '',
          namespaceId: String(installation.account?.id ?? ''),
          accountType: installation.account?.type ?? 'Organization',
          suspended: installation.suspended_at !== null && installation.suspended_at !== undefined,
        });
      }
      if (batch.length < 100) break;
      page += 1;
    }
    return installations;
  }

  /** All repos accessible to an installation, paginated 100 at a time */
  async listRepos(installationId: string): Promise<RemoteRepo[]> {
    const repos: RemoteRepo[] = [];
    let page = 1;
    for (;;) {
      const body = await this.api<{ repositories: GithubRepoPayload[] }>(
        `/installation/repositories?per_page=100&page=${page}`,
        installationId,
      );
      const batch = body.repositories ?? [];
      for (const repo of batch) repos.push(toRemoteRepo(repo, installationId));
      if (batch.length < 100) break;
      page += 1;
    }
    return repos;
  }

  /** Single repo by GitHub database ID; null on missing installation or API error */
  async getRepo(forgeRepoId: string, installationId?: string): Promise<RemoteRepo | null> {
    if (!installationId) return null;
    try {
      const repo = await this.api<GithubRepoPayload>(
        `/repositories/${encodeURIComponent(forgeRepoId)}`,
        installationId,
      );
      return toRemoteRepo(repo, installationId);
    } catch (err) {
      this.log.warn('could not read repo', {
        forge_repo_id: forgeRepoId,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /** Look for a root config in the default branch's root listing */
  async hasRootConfig(repo: RemoteRepo): Promise<boolean | null> {
    if (!repo.installationId) return null;
    try {
      const entries = await this.api<{ name: string; type: string }[]>(
        `/repos/${repo.namespace}/${repo.name}/contents?ref=${encodeURIComponent(repo.defaultBranch)}`,
        repo.installationId,
      );
      return entries.some((entry) => entry.type === 'file' && isConfigFilename(entry.name));
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 404) return false;
      this.log.warn('could not list the root of a repo', {
        forge_repo_id: repo.forgeRepoId,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /** Clone or fetch a mirror of the repo, return the default branch SHA */
  async fetchInto(repo: RemoteRepo, mirrorDir: string): Promise<string> {
    if (!repo.installationId) throw new Error(`repo ${repo.forgeRepoId} has no installation`);
    const host = this.config.base_url ? new URL(this.config.base_url).host : 'github.com';
    const url = await this.minter.authenticatedUrl(
      repo.installationId,
      `https://${host}/${repo.namespace}/${repo.name}.git`,
    );
    await ensureMirror(mirrorDir, { authenticatedUrl: url });
    return gitResolveHead(mirrorDir, repo.defaultBranch);
  }

  /** Check out a tree at a given SHA into a working directory */
  async checkout(mirrorDir: string, sha: string, targetDir: string): Promise<void> {
    await checkoutTree(mirrorDir, sha, targetDir);
  }

  /** Resolve a branch name to its commit SHA in a mirror */
  async resolveHead(mirrorDir: string, branch: string): Promise<string> {
    return gitResolveHead(mirrorDir, branch);
  }

  /** Create a check-run on the repo; silence errors so the caller proceeds */
  async reportCheck(
    repo: RemoteRepo,
    sha: string,
    result: { conclusion: 'success' | 'failure'; title: string; summary: string },
  ): Promise<void> {
    if (!repo.installationId) return;
    try {
      await this.api(`/repos/${repo.namespace}/${repo.name}/check-runs`, repo.installationId, {
        method: 'POST',
        body: JSON.stringify({
          name: 'speicher',
          head_sha: sha,
          status: 'completed',
          conclusion: result.conclusion,
          output: { title: result.title, summary: result.summary },
        }),
      });
    } catch (err) {
      // Not: swallow to let caller proceed even if GitHub is unreachable
      this.log.warn('could not post check run', {
        forge_repo_id: repo.forgeRepoId,
        error: (err as Error).message,
      });
    }
  }

  /** Derive the local mirror directory path for a repo */
  mirrorDirFor(root: string, repo: RemoteRepo): string {
    return join(root, this.key, `${repo.forgeRepoId}.git`);
  }

  /** Discard cached tokens for an installation (e.g. after app uninstalled) */
  forgetInstallation(installationId: string): void {
    this.minter.forget(installationId);
  }

  /** App JWT-authenticated call */
  private async appApi<T>(path: string): Promise<T> {
    const jwt = await this.minter.appJwt();
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      headers: githubHeaders(jwt),
    });
    if (!response.ok) throw new GithubApiError(path, response);
    return (await response.json()) as T;
  }

  /** Installation-authenticated call with rate-limit acquisition and observation */
  private async api<T>(path: string, installationId: string, init: RequestInit = {}): Promise<T> {
    await this.limiter.acquire(installationId);
    const token = await this.minter.installationToken(installationId);
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...githubHeaders(token),
        'Content-Type': 'application/json',
      },
    });
    this.limiter.observe(installationId, response.headers);
    if (!response.ok) throw new GithubApiError(path, response);
    if (response.status === 204) return {} as T;
    return (await response.json()) as T;
  }
}

class GithubApiError extends Error {
  readonly status: number;

  constructor(path: string, response: Response) {
    super(`GitHub ${path} -> ${response.status} ${response.statusText}`);
    this.name = 'GithubApiError';
    this.status = response.status;
  }
}

interface GithubInstallationPayload {
  id: number;
  suspended_at?: string | null;
  account?: { login: string; id: number; type: string };
}

interface GithubRepoPayload {
  id: number;
  name: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
  owner: { login: string; id: number; type: string };
}

/** Map a GitHub API repo payload to a forge-agnostic RemoteRepo */
function toRemoteRepo(repo: GithubRepoPayload, installationId: string): RemoteRepo {
  return {
    forgeRepoId: String(repo.id),
    namespace: repo.owner.login,
    // Not: namespaceId tracks the owner's GitHub database ID to survive renames
    namespaceId: String(repo.owner.id),
    name: repo.name,
    defaultBranch: repo.default_branch,
    private: repo.private,
    archived: repo.archived,
    installationId,
  };
}
