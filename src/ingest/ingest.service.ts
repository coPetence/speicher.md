/**
 * Syncs repository content from a working tree into the database
 *
 * walkRepo parses configs, resolves grants, renders pages, and collects findings
 * writeWalk persists the result inside a single database transaction
 * A SyncRun record is created for every invocation, tracking status and findings
 *
 * NotPublishedError is a normal state — the repo is purged and marked as unpublished
 */
import { Injectable } from '@nestjs/common';
import { Sequelize } from 'sequelize';

import { BlobStore } from '../assets/blob-store';
import { parseDurationWithFallback } from '../common/time';
import { Logger, rootLogger } from '../common/logger';
import { ConfigService } from '../config/config.service';
import { RoutingService } from '../content-reader/routing';
import { Forge, Repo, SyncRun, initModels } from '../db/models';
import { getSequelize } from '../db/sequelize';
import { Finding } from './findings';
import { DirectoryLookup } from './grants';
import { NotPublishedError } from './walk/root';
import { RepoLookup, WalkResult, walkRepo } from './walk/walk';
import { retained } from './write/plan';
import { purgeRepoRows } from './write/sweep';
import { WriteWalkResult, writeWalk } from './write/write';

/**
 * Input to syncRepo
 */
export interface SyncOptions {
  workingTree: string; // Root of the file tree to ingest

  sha: string; // Commit SHA being ingested
  trigger?: 'webhook' | 'reconciler' | 'manual' | 'grant-review' | 'rebuild';
  directory?: DirectoryLookup; // Directory service for resolving grant subjects
  now?: Date; // Overrideable clock, for testing or forced grant re-evaluation
}

/**
 * Outcome of a sync
 */
export interface SyncResult {
  status: 'ok' | 'failed'; // Failed when a rejection-severity finding exists
  runId: string; // SyncRun database ID
  sha: string;
  findings: Finding[]; // Validation findings from the walk
  stats: {
    documents: number;
    folders: number;
    assets: number;
    assets_uploaded: number; // Assets whose content was not already in blob storage
    chunks_written: number;
    redirects: number;
    dropped_grants: number;
    failed_subtrees: string[];
  };

  authorSummary: string | null; // User-facing error message, null on success
}

/**
 * Orchestrates syncing a repo's working tree into sync tables
 */
@Injectable()
export class IngestService {
  private readonly log: Logger;

  constructor(
    private readonly config: ConfigService,
    private readonly blobs: BlobStore,
    private readonly sequelize: Sequelize = getSequelize(),
  ) {
    this.log = rootLogger.child('ingest');
    initModels(this.sequelize);
  }

  /**
   * Returns a RepoLookup that resolves path segments via RoutingService
   */
  private repoLookup(tenantId: string): RepoLookup {
    const routing = new RoutingService(this.config, this.sequelize);
    return {
      resolve: async (segments) => {
        const route = await routing.resolve(tenantId, segments);
        return route === null ? null : { repoId: route.repoId, slugPath: route.slugPath };
      },
    };
  }

  /**
   * Walks the working tree and persists the result
   *
   * NotPublishedError is a normal state — the repo is purged and marked as unpublished
   */
  async syncRepo(repoId: string, options: SyncOptions): Promise<SyncResult> {
    const repo = await Repo.findByPk(repoId);
    if (!repo) throw new Error(`no such repo ${repoId}`);

    const run = await SyncRun.create({
      tenant_id: repo.tenant_id,
      repo_id: repo.id,
      sha: options.sha,
      trigger: options.trigger ?? 'manual',
      status: 'running',
    });

    try {
      const walk = await walkRepo({
        workingTree: options.workingTree,
        config: this.config,

        repo: { namespace: repo.namespace, slug: repo.slug },
        directory: options.directory,
        repos: this.repoLookup(repo.tenant_id),
        now: options.now,
        expiryWarningMs: parseDurationWithFallback(this.config.notify.expiry_warning, '14d'),
      });

      const written = await writeWalk({
        sequelize: this.sequelize,
        blobs: this.blobs,
        repo,
        forgeKey: await this.forgeKeyFor(repo.forge_id),
        sha: options.sha,
        walk,
      });
      return await this.finishWritten(repo, run.id, walk, written);
    } catch (err) {
      if (err instanceof NotPublishedError) return this.finishUnpublished(repo, run, options.sha);
      return this.finishFailed(repo, run, options.sha, (err as Error).message);
    }
  }

  /**
   * Updates the run record and returns the result after walk and write complete
   */
  private async finishWritten(
    repo: Repo,
    runId: string,
    walk: WalkResult,
    written: WriteWalkResult,
  ): Promise<SyncResult> {
    const { plan, verdict } = written;
    const stats = {
      documents: retained(plan, walk.documents, (d) => d.slugPath).length,
      folders: retained(plan, walk.folders, (f) => f.slugPath).length,
      assets: retained(plan, walk.assets, (a) => a.slugPath).length,
      assets_uploaded: written.assetsUploaded,
      chunks_written: written.chunksWritten,
      redirects: written.redirects.length,
      dropped_grants: walk.documents.reduce(
        (n, d) => n + (d.configSource.dropped_grants?.length ?? 0),
        0,
      ),
      failed_subtrees: plan.failed,
    };

    const status: 'ok' | 'failed' = verdict.failed ? 'failed' : 'ok';
    await SyncRun.update(
      {
        status,
        finished_at: new Date(),
        stats,
        findings: walk.findings.all,
        error: verdict.adminError,
      },
      { where: { id: runId } },
    );

    this.log.info('sync finished', {
      repo_id: repo.id,
      sha: plan.sha,
      status,
      documents: stats.documents,
      assets: stats.assets,
      failed_subtrees: plan.failed.length,
    });

    return {
      status,
      runId,
      sha: plan.sha,
      findings: walk.findings.all,
      stats,
      authorSummary: verdict.authorError,
    };
  }

  /**
   * Records a repo the forge reports without a root config, so it is never fetched
   */
  async recordUnpublished(repoId: string, trigger: SyncOptions['trigger']): Promise<void> {
    const repo = await Repo.findByPk(repoId);
    if (!repo) return;
    const run = await SyncRun.create({
      tenant_id: repo.tenant_id,
      repo_id: repo.id,
      sha: null,
      trigger: trigger ?? 'manual',
      status: 'running',
    });
    await this.markUnpublished(repo, run, null);
  }

  /**
   * Purges the repo and marks it as unpublished when no root config exists
   */
  private async finishUnpublished(repo: Repo, run: SyncRun, sha: string): Promise<SyncResult> {
    await this.markUnpublished(repo, run, sha);
    return {
      status: 'ok',
      runId: run.id,
      sha,
      findings: [],
      stats: emptyStats(),
      authorSummary: null,
    };
  }

  /** Purges the repo's content and marks the repo and its run as unpublished */
  private async markUnpublished(repo: Repo, run: SyncRun, sha: string | null): Promise<void> {
    await this.purgeRepo(repo.id);
    await run.update({ status: 'ok', finished_at: new Date(), stats: { unpublished: true } });
    await repo.update({
      has_config: false,
      last_sha: sha,
      last_run_at: new Date(),
      last_status: 'ok',
      last_error: null,
      last_error_public: null,
    });
  }

  /**
   * Records the error, marks the run as failed, and updates the repo's last status
   */
  private async finishFailed(
    repo: Repo,
    run: SyncRun,
    sha: string,
    message: string,
  ): Promise<SyncResult> {
    this.log.error('sync failed', { repo_id: repo.id, error: message });
    await run.update({ status: 'failed', finished_at: new Date(), error: message });
    await repo.update({
      last_run_at: new Date(),
      last_status: 'failed',
      last_error: message,
      last_error_public: 'sync failed — see /-/status for details',
    });
    return {
      status: 'failed',
      runId: run.id,
      sha,
      findings: [],
      stats: emptyStats(),
      authorSummary: `✗ speicher — sync failed\n  ${message}\n  Serving the previous version until this is fixed.`,
    };
  }

  /**
   * Removes all sync rows and blob storage for a repo
   */
  async purgeRepo(repoId: string): Promise<void> {
    await purgeRepoRows(this.sequelize, repoId);
    await this.blobs.purgeRepo(repoId);
  }

  /**
   * Returns the forge's key, or empty string when the forge is not found
   */
  private async forgeKeyFor(forgeId: string): Promise<string> {
    const forge = await Forge.findByPk(forgeId, { attributes: ['key'] });
    return forge?.key ?? '';
  }
}

function emptyStats() {
  return {
    documents: 0,
    folders: 0,
    assets: 0,
    assets_uploaded: 0,
    chunks_written: 0,
    redirects: 0,
    dropped_grants: 0,
    failed_subtrees: [] as string[],
  };
}
