/**
 * Git remote forge driver
 *
 * Works against a plain git remote over ssh or https
 * No webhooks: the caller must poll or trigger manually
 * No installations: repos are statically configured in the forge config
 * Credentials are per-repo deploy keys or tokens
 */

import { Logger, rootLogger } from '../../common/logger';
import { ForgeConfig, GitRepoConfig, gitRepositoryOwner } from '../../config/types';
import { GitCredential, GitInvocation, withGitCredential } from '../credential';
import type { WebhookVerification } from '../../webhooks/signed-delivery';
import { ForgeAction, ForgeDriver, RemoteInstallation, RemoteRepo } from '../driver';
import { CheckedOutCommit, CommitTree, checkoutCommit, resolveRemoteHead } from '../git';

export class GitDriver implements ForgeDriver {
  readonly type = 'git' as const;
  readonly acceptsWebhooks = false;
  readonly hasInstallations = false;
  private readonly log: Logger = rootLogger.child('forge.git');

  constructor(
    readonly key: string,
    private readonly config: ForgeConfig,
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

  /** Resolve the configured branch, or the remote HEAD, and set repo.defaultBranch to it */
  async remoteHead(repo: RemoteRepo): Promise<string> {
    const head = await this.withRemote(repo, (remote) =>
      resolveRemoteHead(remote, repo.defaultBranch),
    );
    repo.defaultBranch = head.branch;
    return head.sha;
  }

  /** Write the files of sha that select picks into targetDir */
  async checkout(
    repo: RemoteRepo,
    sha: string,
    targetDir: string,
    select: (tree: CommitTree) => Promise<void>,
  ): Promise<CheckedOutCommit> {
    return this.withRemote(repo, (remote) => checkoutCommit(remote, sha, targetDir, select));
  }

  /** No-op: plain git remotes have no commit status API */
  async reportCheck(): Promise<void> {}

  /** Run with the repo's URL and credentials */
  protected withRemote<T>(
    repo: RemoteRepo,
    run: (remote: GitInvocation) => Promise<T>,
  ): Promise<T> {
    const entry = this.entry(repo.forgeRepoId);
    if (!entry) throw new Error(`repo ${repo.forgeRepoId} is not configured on forge ${this.key}`);
    return withGitCredential(entry.url, this.credentialFor(entry), run);
  }

  /** Find a configured repo by its id field */
  private entry(forgeRepoId: string): GitRepoConfig | undefined {
    return (this.config.repos ?? []).find((repo) => repo.id === forgeRepoId);
  }

  /** The repo's own credentials, with the host keys of the forge config */
  private credentialFor(entry: GitRepoConfig): GitCredential {
    return {
      deployKey: entry.deploy_key,
      knownHosts: this.config.known_hosts,
      token: entry.token,
      username: entry.username,
    };
  }

  /** The configured branch; empty means the remote HEAD, which remoteHead resolves */
  private async branchOf(entry: GitRepoConfig): Promise<string> {
    return entry.branch ?? '';
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
