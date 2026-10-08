import { QueryInterface } from 'sequelize';

import { ConfigError } from '../../common/errors';
import { rootLogger } from '../../common/logger';
import { ConfigService } from '../../config/config.service';
import { loadActiveInstanceConfig } from '../../config/loader';
import { VECTOR_INDEX_NAME } from '../../embed/distance';
import { ensureVectorIndex } from '../../embed/vector-index';

/**
 * Gives `chunks.embedding` the width of the configured embedding model and builds the
 * ANN index on it. pgvector cannot index a column without a width, and the width is
 * only known from the instance config, so this step reads the running config.
 *
 * An instance with no `embedding` block gets no index. `EmbedService` calls
 * `ensureVectorIndex` itself once embedding is configured and vectors are written.
 */
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const result = await ensureVectorIndex(await configuredDimensions(), context.sequelize);
  if (result.status === 'unconfigured') {
    rootLogger.child('migrate').info('no embedding configured; ANN index deferred');
  }
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.query(`DROP INDEX IF EXISTS ${VECTOR_INDEX_NAME}`);
  // Back to a bare `vector`, so the next `up` takes its width from the config again
  await q.query(`ALTER TABLE chunks ALTER COLUMN embedding TYPE vector`);
}

/**
 * configuredDimensions returns `embedding.dimensions` from the running config, or
 * null if none is configured or the config does not load. A config that does not
 * load must not stop the schema from being migrated.
 */
async function configuredDimensions(): Promise<number | null> {
  try {
    return new ConfigService(await loadActiveInstanceConfig()).embedding?.dimensions ?? null;
  } catch (err) {
    if (err instanceof ConfigError) {
      rootLogger.child('migrate').warn('instance config did not load; ANN index deferred', {
        error: (err as Error).message,
      });
      return null;
    }
    throw err;
  }
}
