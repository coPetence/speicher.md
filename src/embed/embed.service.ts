/**
 * Embed pending chunks within two-thirds of the queue visibility timeout
 * Return partial progress when time runs out so the queue can retry
 */
import { QueryTypes, Sequelize } from 'sequelize';

import { Logger, rootLogger } from '../common/logger';
import { getSequelize } from '../db/sequelize';
import { toPgTextArray } from '../db/pg-array';
import { toVectorLiteral } from '../db/vector';
import { VISIBILITY_TIMEOUT_MS } from '../jobs/queue';
import { EmbeddingClient, EmbeddingDimensionError, EmbeddingError } from './client';

export const EMBED_BUDGET_MS = Math.floor((VISIBILITY_TIMEOUT_MS * 2) / 3);

export interface EmbedRun {
  /** Chunks embedded this run */
  embedded: number;

  /** Chunks awaiting embedding */
  remaining: number;

  /** Stopped with pending chunks after reaching the time limit */
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
      throw new EmbeddingError(
        'embedding.bad-response',
        `embedding endpoint returned ${vectors.length} vectors for ${slice.length} chunks`,
        null,
        false,
      );
    }
    for (const vector of vectors) {
      // Reject dimension mismatches before writing
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
          -- Preserve embeddings written by other runners
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
