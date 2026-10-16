/**
 * Sync a repo's git history into speicher
 *
 * Fetches the latest commit from the forge, checks it out to a temp directory,
 * and hands it to the ingest pipeline. Records check runs on the forge and sends
 * notifications on state change
 *
 * A repo whose forge reports no root config is marked unpublished without being fetched
 * A repo whose namespace is no longer accepted is purged instead of synced
 * A repo whose SHA hasn't moved (and whose last sync was ok) is skipped unless
 * the trigger demands it
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';

import { Logger, rootLogger } from '../common/logger';
import { Repo, initModels } from '../db/models';
import { getSequelize } from '../db/sequelize';
import { RemoteRepo } from '../forge/driver';
import { MIRROR_ROOT, commitAuthorEmail } from '../forge/git';
import { ForgeRegistry } from '../forge/registry';
import { IngestService, SyncResult } from '../ingest/ingest.service';
import { NotifyService } from '../notify/notify.service';
import { RoutingService } from '../content-reader/routing';

export { MIRROR_ROOT };

@Injectable()
export class SyncService {
  private readonly log: Logger = rootLogger.child('sync');

  constructor(
    private readonly forges: ForgeRegistry,
    private readonly ingest: IngestService,
    private readonly routing: RoutingService,
    private readonly notify: NotifyService,
  ) {
    initModels();
  }

  async syncRepo(
    repoId: string,
    trigger: 'webhook' | 'reconciler' | 'manual' | 'grant-review' | 'rebuild',
  ): Promise<SyncResult | null> {
    const repo = await Repo.findByPk(repoId);
    if (!repo) return null;

    const driver = await this.forges.driverForRepo(repo);
    if (!driver) {
      this.log.warn('no driver for repo', { repo_id: repoId });
      return null;
    }

    const remote = await this.forges.remoteRepoFor(repo);
    if (!remote) {
      this.log.warn('repo is not reachable on the forge', { repo_id: repoId });
      return null;
    }

    if (!repo.has_config && (await driver.hasRootConfig?.(remote)) === false) {
      this.log.debug('no root .speicher.yaml, so the repo is not fetched', { repo_id: repoId });
      await this.ingest.recordUnpublished(repoId, trigger);
      return null;
    }

    const mirrorDir = join(MIRROR_ROOT, driver.key, `${remote.forgeRepoId}.git`);
    const head = await driver.fetchInto(remote, mirrorDir);

    const forced = trigger === 'grant-review' || trigger === 'rebuild';
    if (!forced && repo.last_sha === head && repo.last_status === 'ok') {
      this.log.debug('head unchanged, nothing to do', { repo_id: repoId, sha: head });
      await Repo.update({ last_run_at: new Date() }, { where: { id: repoId } });
      return null;
    }

    const workingTree = await fs.mkdtemp(join(tmpdir(), `speicher-${remote.forgeRepoId}-`));
    try {
      await driver.checkout(mirrorDir, head, workingTree);

      if (remote.defaultBranch && repo.branch !== remote.defaultBranch) {
        await Repo.update({ branch: remote.defaultBranch }, { where: { id: repoId } });
      }

      const result = await this.ingest.syncRepo(repoId, {
        workingTree,
        sha: head,
        trigger,
        directory: await this.forges.directoryFor(driver.key),
      });

      await this.report(repo, remote, head, result, mirrorDir);
      return result;
    } finally {
      await fs.rm(workingTree, { recursive: true, force: true });
    }
  }

  /**
   * Post a check run on the forge and notify listeners of the new state
   */
  private async report(
    repo: Repo,
    remote: RemoteRepo,
    sha: string,
    result: SyncResult,
    mirrorDir: string,
  ): Promise<void> {
    const driver = await this.forges.driverForRepo(repo);
    if (driver) {
      await driver.reportCheck(remote, sha, {
        conclusion: result.status === 'ok' ? 'success' : 'failure',
        title: result.status === 'ok' ? 'Sync succeeded' : 'Sync failed',
        summary:
          result.authorSummary ??
          `Ingested ${result.stats.documents} pages and ${result.stats.assets} assets.`,
      });
    }

    const committerEmail = await commitAuthorEmail(mirrorDir, sha).catch(() => null);
    await this.notify.onSyncStateChange(repo, result, committerEmail, this.routing);
  }

  /**
   * Find repos whose next sync is due
   *
   * Bucks to spread load when many repos share the same poll_interval_ms
   * Only repos with config (or never-synced) are considered
   */
  async dueForReconcile(
    intervalMs: number,
    buckets = 12,
  ): Promise<{ id: string; reason: string }[]> {
    const rows = await getSequelize().query<{
      id: string;
      last_run_at: Date | null;
      next_grant_review_at: Date | null;
      poll_interval_ms: number | null;
    }>(
      // has_config=true or never-run repos are the only ones that can produce content
      `SELECT id, last_run_at, next_grant_review_at, poll_interval_ms FROM repos
        WHERE has_config = true OR last_run_at IS NULL`,
      { type: QueryTypes.SELECT },
    );

    const now = Date.now();
    const due: { id: string; reason: string }[] = [];

    for (const row of rows) {
      // Grant-review deadline takes priority over the poll interval
      if (row.next_grant_review_at && new Date(row.next_grant_review_at).getTime() <= now) {
        due.push({ id: row.id, reason: 'grant-review' });
        continue;
      }
      const interval = row.poll_interval_ms ?? intervalMs;
      const offset = (hashToBucket(row.id, buckets) * (interval / buckets)) % interval;
      const last = row.last_run_at ? new Date(row.last_run_at).getTime() : 0;
      if (now - last >= interval + offset) due.push({ id: row.id, reason: 'reconciler' });
    }
    return due;
  }
}

/**
 * Distribute an ID across a fixed number of buckets
 *
 * Used to spread repo poll times so that repos with identical intervals don't
 * all fire at the same wall-clock moment
 */
export function hashToBucket(id: string, buckets: number): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % buckets;
}
