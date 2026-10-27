/** Manage the chunks.embedding index, enforcing configured dimensions */

import { QueryTypes, Sequelize } from 'sequelize';

import { rootLogger } from '../common/logger';
import { VECTOR_INDEX_METHOD, VECTOR_INDEX_NAME, VECTOR_OPS } from './distance';
import { getSequelize } from '../db/sequelize';
import { CodedError } from '../common/errors';

/** Stored embedding dimensions differ from the configuration */
export class StoredWidthError extends CodedError<'embedding.stored-width-mismatch'> {
  constructor(
    readonly stored: number[],
    readonly configured: number,
    message: string,
  ) {
    super('embedding.stored-width-mismatch', message);
  }
}

/** Index creation outcome */
export type VectorIndexResult =
  | { status: 'created'; dimensions: number }
  | { status: 'present'; dimensions: number }
  | { status: 'unconfigured' };

/** List distinct dimensions of stored embeddings */
export async function storedDimensions(sequelize: Sequelize = getSequelize()): Promise<number[]> {
  const rows = await sequelize.query<{ embedding_dim: number }>(
    `SELECT DISTINCT embedding_dim FROM chunks
      WHERE embedding IS NOT NULL AND embedding_dim IS NOT NULL
      ORDER BY embedding_dim`,
    { type: QueryTypes.SELECT },
  );
  return rows.map((row) => row.embedding_dim);
}

/** Check stored dimensions, then resize and index if needed */
export async function ensureVectorIndex(
  configuredDimensions: number | null,
  sequelize: Sequelize = getSequelize(),
): Promise<VectorIndexResult> {
  const log = rootLogger.child('embed');
  if (!configuredDimensions) {
    log.info('no embedding dimension is configured; vector index not created');
    return { status: 'unconfigured' };
  }

  const wrong = (await storedDimensions(sequelize)).filter((d) => d !== configuredDimensions);
  if (wrong.length > 0) {
    throw new StoredWidthError(
      wrong,
      configuredDimensions,
      `chunks hold embeddings ${wrong.join(' and ')} wide, but embedding.dimensions ` +
        `is ${configuredDimensions}. The index can only be pinned to one width: clear ` +
        'the embeddings that do not match the configured model and let them be ' +
        'written again.',
    );
  }

  if (await indexExists(sequelize)) return { status: 'present', dimensions: configuredDimensions };

  if ((await columnDimensions(sequelize)) !== configuredDimensions) {
    await sequelize.query(
      `ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(${configuredDimensions})`,
      { type: QueryTypes.RAW },
    );
  }

  await sequelize.query(
    `CREATE INDEX IF NOT EXISTS ${VECTOR_INDEX_NAME}
        ON chunks USING ${VECTOR_INDEX_METHOD} (embedding ${VECTOR_OPS})`,
    { type: QueryTypes.RAW },
  );
  log.info('vector index created', {
    dimensions: configuredDimensions,
    method: VECTOR_INDEX_METHOD,
    ops: VECTOR_OPS,
  });
  return { status: 'created', dimensions: configuredDimensions };
}

/** Check for the vector index in pg_class */
async function indexExists(sequelize: Sequelize): Promise<boolean> {
  const rows = await sequelize.query<{ exists: boolean }>(
    `SELECT true AS exists FROM pg_class WHERE relname = :name AND relkind = 'i'`,
    { type: QueryTypes.SELECT, replacements: { name: VECTOR_INDEX_NAME } },
  );
  return rows.length > 0;
}

/** Read embedding column dimensions, or null if unconstrained */
async function columnDimensions(sequelize: Sequelize): Promise<number | null> {
  const rows = await sequelize.query<{ typmod: number }>(
    `SELECT a.atttypmod AS typmod
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'chunks' AND a.attname = 'embedding'`,
    { type: QueryTypes.SELECT },
  );

  const typmod = rows[0]?.typmod ?? -1;
  return typmod > 0 ? typmod : null;
}
