/**
 * Embed text chunks into vectors
 *
 * Pulls chunks from the database that have no embedding, sends them through the
 * embedding client, and writes the resulting vectors back
 *
 * Runs within a time budget defined as two-thirds of the job visibility timeout.
 * When the budget is exhausted it hands back a partial result so the queue can
 * retry the remainder without letting the caller's lock expire
 *
 * Not configured (client is null) -> embedded 0, remaining 0, not exhausted
 */
import { QueryTypes, Sequelize } from 'sequelize';

import { Logger, rootLogger } from '../common/logger';
import { getSequelize } from '../db/sequelize';
import { toPgTextArray } from '../db/pg-array';
import { toVectorLiteral } from '../db/vector';
import { VISIBILITY_TIMEOUT_MS } from '../jobs/queue';
import { ensureVectorIndex } from './vector-index';
import { EmbeddingClient, EmbeddingDimensionError } from './client';

export const EMBED_BUDGET_MS = Math.floor((VISIBILITY_TIMEOUT_MS * 2) / 3);

export interface EmbedRun {
  /** Chunks successfully embedded this run */
  embedded: number;

  /** Chunks still awaiting embedding */
  remaining: number;

  /** True if the run stopped early due to time budget */
  exhausted: boolean;
}

export class EmbedService {
  private readonly log: Logger = rootLogger.child('embed');

  constructor(
    private readonly client: EmbeddingClient | null,
    private readonly sequelize: Sequelize = getSequelize(),
    private readonly now: () => number = Date.now,
  ) {}

  get configured(): boolean {
    return this.client !== null;
  }

  async embedPending(tenantId: string): Promise<EmbedRun> {
    const client = this.client;
    if (!client) return { embedded: 0, remaining: 0, exhausted: false };

    const sliceSize = client.config.batch_size * client.config.max_concurrency;
    const deadline = this.now() + EMBED_BUDGET_MS;
    let embedded = 0;

    for (;;) {
      if (this.now() >= deadline) {
        const remaining = await this.pendingCount(tenantId);
        if (remaining > 0) {
          this.log.info('embed budget spent; handing back', { embedded, remaining });
          return { embedded, remaining, exhausted: true };
        }
        return { embedded, remaining: 0, exhausted: false };
      }

      const slice = await this.claimSlice(tenantId, sliceSize);
      if (slice.length === 0) break;

      const vectors = await client.embed(slice.map((chunk) => chunk.text));
      embedded += await this.writeVectors(slice, vectors, client);
    }

    if (embedded > 0) await ensureVectorIndex(client.dimensions, this.sequelize);

    this.log.info('embed run finished', { embedded });
    return { embedded, remaining: 0, exhausted: false };
  }

  private async claimSlice(
    tenantId: string,
    limit: number,
  ): Promise<{ id: string; text: string }[]> {
    return this.sequelize.query<{ id: string; text: string }>(
      `SELECT id, text FROM chunks
        WHERE tenant_id = :tenantId AND embedding IS NULL
        ORDER BY id
        LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { tenantId, limit } },
    );
  }

  private async writeVectors(
    slice: { id: string; text: string }[],
    vectors: number[][],
    client: EmbeddingClient,
  ): Promise<number> {
    if (vectors.length !== slice.length) {
      throw new Error(
        `embedding endpoint returned ${vectors.length} vectors for ${slice.length} chunks`,
      );
    }
    for (const vector of vectors) {
      // Validate dimension count before write -- the UPDATE below silently ignores
      // mismatched dimensions via the vector cast
      if (vector.length !== client.dimensions) {
        throw new EmbeddingDimensionError(client.dimensions, vector.length, client.model);
      }
    }

    const [, affected] = await this.sequelize.query(
      `UPDATE chunks AS c
          SET embedding = v.embedding::vector,
              embedding_model = :model,
              embedding_dim = :dimensions
         FROM unnest(CAST(:ids AS uuid[]), CAST(:vectors AS text[])) AS v(id, embedding)
        WHERE c.id = v.id
          -- Only ever fills a blank. A row another runner reached first keeps the
          -- vector it already has, which is the same vector: the text decides it.
          AND c.embedding IS NULL`,
      {
        type: QueryTypes.UPDATE,
        replacements: {
          model: client.model,
          dimensions: client.dimensions,
          ids: toPgTextArray(slice.map((chunk) => chunk.id)),
          vectors: toPgTextArray(vectors.map(toVectorLiteral)),
        },
      },
    );
    return typeof affected === 'number' ? affected : slice.length;
  }

  private async pendingCount(tenantId: string): Promise<number> {
    const rows = await this.sequelize.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chunks
        WHERE tenant_id = :tenantId AND embedding IS NULL`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
    return Number(rows[0]?.count ?? 0);
  }
}
