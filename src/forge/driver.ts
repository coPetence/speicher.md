import type { WebhookVerification } from '../webhooks/signed-delivery';
import type { CheckedOutCommit, CommitTree } from './git';

export interface RemoteRepo {
  /** A repo as the remote forge reports it; forgeRepoId stays stable across renames */
  forgeRepoId: string;
  namespace: string;

  /** namespaceId is the numeric id of the account behind namespace */
  namespaceId: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  installationId?: string;
}

export interface RemoteInstallation {
  /** A forge app installation as reported by the forge's app API */
  installationId: string;
  namespace: string;

  /** namespaceId is the numeric id of the account behind namespace */
  namespaceId: string;

  /** accountType is the forge's account kind, e.g. 'User' or 'Organization' */
  accountType: string;
  suspended: boolean;
}

export type ForgeAction =
  | { kind: 'sync'; forgeRepoId: string; sha?: string; reason: string }
  | { kind: 'validate-pr'; forgeRepoId: string; sha: string; prNumber: number }
  | { kind: 'rename'; forgeRepoId: string; oldName: string; newName: string }
  | { kind: 'purge'; forgeRepoId: string; reason: string }
  | { kind: 'discover'; installationId: string }
  | { kind: 'purge-installation'; installationId: string }
  | { kind: 'ignore'; reason: string };

export interface ForgeDriver {
  readonly type: 'github' | 'gitlab' | 'gitea' | 'forgejo' | 'git';
  readonly key: string;

  /** Whether the driver receives webhook deliveries; false for plain git remotes */
  readonly acceptsWebhooks: boolean;

  /** Whether repos hang off installable app installations; false for plain git remotes */
  readonly hasInstallations: boolean;

  /** Check a delivery's signature and pull out its delivery id and event */
  verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): WebhookVerification;

  /** Reduce one delivery to the actions it implies, filtered to tracked branches */
  mapEvent(event: string, payload: Record<string, unknown>): ForgeAction[];

  /** All installations of the forge app visible to this tenant */
  listInstallations(): Promise<RemoteInstallation[]>;

  /** The repos reachable through one installation */
  listRepos(installationId: string): Promise<RemoteRepo[]>;
  getRepo(forgeRepoId: string, installationId?: string): Promise<RemoteRepo | null>;

  /**
   * Whether the default branch has a root `.speicher.yaml` or `.speicher.yml`
   */
  hasRootConfig?(repo: RemoteRepo): Promise<boolean | null>;

  misnamedRootConfig?(repo: RemoteRepo): Promise<string | null>;

  /** Return the head sha of the default branch without downloading the repo */
  remoteHead(repo: RemoteRepo): Promise<string>;

  /** Write the files of one commit that select picks into targetDir */
  checkout(
    repo: RemoteRepo,
    sha: string,
    targetDir: string,
    select: (tree: CommitTree) => Promise<void>,
  ): Promise<CheckedOutCommit>;

  /** Post a check-run conclusion for a sha back to the forge */
  reportCheck(
    repo: RemoteRepo,
    sha: string,
    result: { conclusion: 'success' | 'failure'; title: string; summary: string },
  ): Promise<void>;
}
