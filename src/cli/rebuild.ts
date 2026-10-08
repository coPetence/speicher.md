/**
 * Enqueue a full rebuild of all repositories
 *
 * Queues one `rebuild` job, which the worker turns into a content sync per repo, so
 * what a full rebuild means is decided in one place. The caller can clear existing
 * content first by setting `purgeFirst`.
 *
 * This is an admin operation, not invoked during normal user flow
 */
import 'reflect-metadata';

import { QueryTypes } from 'sequelize';

import { rootLogger } from '../common/logger';
import { initModels } from '../db/models';
import { getSequelize } from '../db/sequelize';
import { tenancy } from '../db/tenancy';
import { JobQueue } from '../jobs/queue';

export interface RebuildOptions {
  /**
   * Clear documents, folders, assets, edges and terms before enqueuing.
   */
  purgeFirst?: boolean;
}

const PURGED_TABLES = ['documents', 'folders', 'assets', 'document_edges', 'document_terms'];

/** Returns the number of repos the rebuild will sync */
export async function enqueueFullRebuild(options: RebuildOptions = {}): Promise<number> {
  const log = rootLogger.child('rebuild');
  initModels();
  const sequelize = getSequelize();
  const tenant = await tenancy.defaultTenant();

  const [{ count }] = await sequelize.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM repos WHERE tenant_id = :tenantId`,
    { type: QueryTypes.SELECT, replacements: { tenantId: tenant.id } },
  );

  if (options.purgeFirst) {
    // Purge in one transaction so that if it fails, nothing is left in a half-purged state
    await sequelize.transaction(async (transaction) => {
      for (const table of PURGED_TABLES) {
        await sequelize.query(`DELETE FROM ${table} WHERE tenant_id = :tenantId`, {
          type: QueryTypes.DELETE,
          replacements: { tenantId: tenant.id },
          transaction,
        });
      }
    });
  }

  await new JobQueue(sequelize).enqueue({
    tenantId: tenant.id,
    kind: 'rebuild',
    payload: { reason: 'cli' },
    dedupeKey: 'rebuild',
  });

  const repos = Number(count);
  log.info('full rebuild enqueued', { repos, purged: options.purgeFirst === true });
  return repos;
}
