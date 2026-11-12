/**
 * Re-embed when the embedding model or dimensions change
 *
 * Clears stale embeddings and enqueues background jobs to re-embed
 * Does not do the embedding work itself
 *
 */

import 'reflect-metadata';

import { QueryTypes, Sequelize } from 'sequelize';

import { rootLogger } from '../common/logger';
import { ConfigService } from '../config/config.service';
import { getSequelize } from '../db/sequelize';
import { JobQueue } from '../jobs/queue';

export interface ReembedResult {
  /** Embeddings nulled because they did not match the current model or dimensions */
  cleared: number;
  /** Chunks whose embedding is NULL after the clear, awaiting re-embedding */
  pending: number;
  model: string;
  dimensions: number;
}

/**
 * Clear stale embeddings and enqueue re-embedding
 *
 * Returns null when no embedding endpoint is configured
 * Not done inline to avoid blocking the caller
 */
export async function reembed(
  tenantId: string,
  config: ConfigService,
  sequelize: Sequelize = getSequelize(),
): Promise<ReembedResult | null> {
  const log = rootLogger.child('embed');
  const embedding = config.embedding;

  if (!embedding) return null;

  // Nulls embeddings that no longer match configured model or dimensions
  // IS DISTINCT FROM treats NULL as unequal to any value
  const [, cleared] = await sequelize.query(
    `UPDATE chunks
        SET embedding = NULL, embedding_model = NULL, embedding_dim = NULL
      WHERE tenant_id = :tenantId
        AND embedding IS NOT NULL
        AND (embedding_model IS DISTINCT FROM :model OR embedding_dim IS DISTINCT FROM :dimensions)`,
    {
      type: QueryTypes.UPDATE,
      replacements: {
        tenantId,
        model: embedding.model,
        dimensions: embedding.dimensions,
      },
    },
  );
  // Sequelize may return the affected count in different shapes
  const clearedCount = typeof cleared === 'number' ? cleared : 0;

  const [row] = await sequelize.query<{ pending: string }>(
    `SELECT count(*) AS pending FROM chunks WHERE tenant_id = :tenantId AND embedding IS NULL`,
    { type: QueryTypes.SELECT, replacements: { tenantId } },
  );
  const pending = Number(row.pending);

  await new JobQueue(sequelize).enqueue({ tenantId, kind: 'embed', dedupeKey: 'embed' });

  log.info('re-embed enqueued', {
    cleared: clearedCount,
    pending,
    model: embedding.model,
    dimensions: embedding.dimensions,
  });
  return {
    cleared: clearedCount,
    pending,
    model: embedding.model,
    dimensions: embedding.dimensions,
  };
}
