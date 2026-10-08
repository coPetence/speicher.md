/**
 * Git remote forge driver
 *
 * Works against a plain git remote over ssh or https
 * No webhooks: the caller must poll or trigger manually
 * No installations: repos are statically configured in the forge config
 * Credentials are per-repo deploy keys or tokens, with optional known_hosts
 */

import { join } from 'node:path';

import { Logger, rootLogger } from '../../common/logger';
import { ForgeConfig, GitRepoConfig, gitRepositoryOwner } from '../../config/types';
import { GitCredential, GitInvocation, withGitCredential } from '../credential';
import {
  ForgeAction,
  ForgeDriver,
  RemoteInstallation,
  RemoteRepo,
  WebhookVerification,
} from '../driver';
import { MIRROR_ROOT, checkoutTree, defaultBranchOf, ensureMirror, resolveHead } from '../git';

/**
 * Fetch the mirror and return the SHA of the default branch HEAD
 *
 * Sets repo.defaultBranch if it was unset, so the caller can reuse it
 */
export async function fetchAndResolve(
  repo: RemoteRepo,
  mirrorDir: string,
  invocation: GitInvocation,
): Promise<string> {
  await ensureMirror(mirrorDir, invocation);

  const branch = repo.defaultBranch || ((await defaultBranchOf(mirrorDir)) ?? '');
  if (!branch) {
    throw new Error(`no branch configured for ${repo.forgeRepoId} and the remote HEAD is unset`);
  }
  repo.defaultBranch = branch;

  return resolveHead(mirrorDir, branch);
}

export class GitDriver implements ForgeDriver {
  readonly type = 'git' as const;
  readonly acceptsWebhooks = false;
  readonly hasInstallations = false;
  private readonly log: Logger = rootLogger.child('forge.git');

  constructor(
    readonly key: string,
    private readonly config: ForgeConfig,
    private readonly mirrorRoot: string = MIRROR_ROOT,
  ) {}

  /** Always invalid: plain git remotes do not send webhooks */
  verifyWebhook(): WebhookVerification {
    return { valid: false, deliveryId: null, event: null };
  }

  /** Always ignore: plain git remotes do not send events */
  mapEvent(): ForgeAction[] {
    return [
      {
        kind: 'ignore',
        reason:
          'Plain git remotes do not send events. Poll the forge or trigger a manual check ' +
          'instead.',
      },
    ];
  }

  /** Empty: repos are statically configured, not discovered through installations */
  async listInstallations(): Promise<RemoteInstallation[]> {
    return [];
  }

  /** Return all repos statically configured on this forge */
  async listRepos(): Promise<RemoteRepo[]> {
    const repos: RemoteRepo[] = [];
    for (const entry of this.config.repos ?? []) {
      repos.push(this.toRemoteRepo(entry, await this.branchOf(entry)));
    }
    return repos;
  }

  /** Return a configured repo by ID, or null if removed from config */
  async getRepo(forgeRepoId: string): Promise<RemoteRepo | null> {
    const entry = this.entry(forgeRepoId);
    if (!entry) {
      this.log.debug('repo is no longer configured', { forge: this.key, repo: forgeRepoId });
      return null;
    }
    return this.toRemoteRepo(entry, await this.branchOf(entry));
  }

  /** Fetch with credential wrapping, return the SHA of the branch HEAD */
  async fetchInto(repo: RemoteRepo, mirrorDir: string): Promise<string> {
    const entry = this.entry(repo.forgeRepoId);
    if (!entry) throw new Error(`repo ${repo.forgeRepoId} is not configured on forge ${this.key}`);

    return withGitCredential(entry.url, this.credentialFor(entry), (invocation) =>
      fetchAndResolve(repo, mirrorDir, invocation),
    );
  }

  /** Write the tree at sha into targetDir */
  async checkout(mirrorDir: string, sha: string, targetDir: string): Promise<void> {
    await checkoutTree(mirrorDir, sha, targetDir);
  }

  /** Return the SHA that refs/heads/branch points to */
  async resolveHead(mirrorDir: string, branch: string): Promise<string> {
    return resolveHead(mirrorDir, branch);
  }

  /** No-op: plain git remotes have no commit status API */
  async reportCheck(): Promise<void> {}

  /** Find a configured repo by its id field */
  private entry(forgeRepoId: string): GitRepoConfig | undefined {
    return (this.config.repos ?? []).find((repo) => repo.id === forgeRepoId);
  }

  /** Merge per-repo credentials, inheriting knownHosts from the forge config */
  private credentialFor(entry: GitRepoConfig): GitCredential {
    return {
      deployKey: entry.deploy_key,
      // known_hosts inherits from forge config if not set per repo
      knownHosts: entry.known_hosts ?? this.config.known_hosts,
      token: entry.token,
      username: entry.username,
    };
  }

  /** Use the configured branch or fall back to the remote HEAD */
  private async branchOf(entry: GitRepoConfig): Promise<string> {
    if (entry.branch) return entry.branch;
    return (await defaultBranchOf(this.mirrorDirFor(entry.id))) ?? '';
  }

  /** Standard mirror directory under the forge key */
  mirrorDirFor(forgeRepoId: string): string {
    return join(this.mirrorRoot, this.key, `${forgeRepoId}.git`);
  }

  /** Map a GitRepoConfig to a RemoteRepo, always private and active */
  private toRemoteRepo(entry: GitRepoConfig, defaultBranch: string): RemoteRepo {
    // The loader refuses a remote URL without an owner, so the fallback is never used
    const owner = gitRepositoryOwner(entry) ?? '';
    return {
      forgeRepoId: entry.id,
      namespace: owner,
      // namespaceId repeats namespace: plain git has no separate numeric ID
      namespaceId: owner,
      name: entry.slug ?? entry.id,
      defaultBranch,
      private: true,
      archived: false,
    };
  }
}
