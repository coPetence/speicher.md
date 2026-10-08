import { QueryTypes } from 'sequelize';

import { Forge, Repo } from '../../src/db/models';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import {
  VECTOR_DISTANCE_OPERATOR,
  VECTOR_INDEX_METHOD,
  VECTOR_INDEX_NAME,
  VECTOR_OPS,
} from '../../src/embed/distance';
import { toVectorLiteral } from '../../src/db/vector';
import { ensureVectorIndex } from '../../src/embed/vector-index';
import { Harness, createHarness, resetVectorIndex } from '../helpers/harness';

const DIM = 8;

let harness: Harness;
let tenantId: string;
let repoId: string;

beforeAll(async () => {
  harness = await createHarness();
  tenantId = harness.tenantId;
  await resetVectorIndex();

  const forge = await Forge.findOne({ where: { tenant_id: tenantId } });
  const repo = await Repo.create({
    tenant_id: tenantId,
    forge_id: (forge as Forge).id,
    forge_repo_id: '41775322',
    namespace: 'copetence',
    namespace_id: '9001',
    slug: 'indexed',
    branch: 'main',
  });
  repoId = repo.id;
});

afterAll(async () => {
  await resetVectorIndex();
  await harness?.close();
  await closeSequelize();
});

beforeEach(async () => {
  await getSequelize().query(`DELETE FROM chunks WHERE tenant_id = :tenantId`, {
    type: QueryTypes.DELETE,
    replacements: { tenantId },
  });
  await resetVectorIndex();
});

function vector(n: number): number[] {
  const angle = (n / 500) * Math.PI * 2;
  return [Math.cos(angle), Math.sin(angle), ...Array.from({ length: DIM - 2 }, () => 0)];
}

async function seedEmbedded(count: number, dimensions = DIM, from = 0): Promise<void> {
  for (let ord = from; ord < from + count; ord += 1) {
    const values = dimensions === DIM ? vector(ord) : Array.from({ length: dimensions }, () => 0.5);
    await getSequelize().query(
      `INSERT INTO chunks (tenant_id, repo_id, slug_path, ord, text, content_hash,
                           embedding, embedding_model, embedding_dim)
       VALUES (:tenantId, :repoId, 'page', :ord, :text, :hash,
               :vector::vector, 'stub-embed', :dimensions)`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          tenantId,
          repoId,
          ord,
          text: `chunk ${ord}`,
          hash: `hash-${ord}`,
          vector: toVectorLiteral(values),
          dimensions,
        },
      },
    );
  }
}

async function planFor(operator: string): Promise<string> {
  const sequelize = getSequelize();
  await sequelize.query(`SET enable_seqscan = off`, { type: QueryTypes.RAW });
  try {
    const rows = await sequelize.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id FROM chunks
        WHERE embedding IS NOT NULL
        ORDER BY embedding ${operator} :probe::vector
        LIMIT 5`,
      { type: QueryTypes.SELECT, replacements: { probe: toVectorLiteral(vector(7)) } },
    );
    return rows.map((row) => row['QUERY PLAN']).join('\n');
  } finally {
    await sequelize.query(`SET enable_seqscan = on`, { type: QueryTypes.RAW });
  }
}

describe('ensureVectorIndex', () => {
  it('builds the index at the configured width and pins the column to it', async () => {
    const result = await ensureVectorIndex(DIM);
    expect(result).toEqual({ status: 'created', dimensions: DIM });

    const [index] = await getSequelize().query<{ method: string; ops: string }>(
      `SELECT am.amname AS method, opc.opcname AS ops
         FROM pg_class i
         JOIN pg_index x ON x.indexrelid = i.oid
         JOIN pg_am am ON am.oid = i.relam
         JOIN pg_opclass opc ON opc.oid = x.indclass[0]
        WHERE i.relname = :name`,
      { type: QueryTypes.SELECT, replacements: { name: VECTOR_INDEX_NAME } },
    );
    expect(index.method).toBe(VECTOR_INDEX_METHOD);
    expect(index.ops).toBe(VECTOR_OPS);

    const [column] = await getSequelize().query<{ typmod: number }>(
      `SELECT a.atttypmod AS typmod FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = 'chunks' AND a.attname = 'embedding'`,
      { type: QueryTypes.SELECT },
    );
    expect(column.typmod).toBe(DIM);

    expect(await ensureVectorIndex(DIM)).toEqual({ status: 'present', dimensions: DIM });
  });

  it('is used by the distance the query uses, and only by it', async () => {
    await seedEmbedded(500);
    await ensureVectorIndex(DIM);
    await getSequelize().query(`ANALYZE chunks`, { type: QueryTypes.RAW });

    expect(await planFor(VECTOR_DISTANCE_OPERATOR)).toContain(VECTOR_INDEX_NAME);

    expect(await planFor('<->')).not.toContain(VECTOR_INDEX_NAME);
  });

  it('refuses rather than guessing when a stored width is not the configured one', async () => {
    await seedEmbedded(3, DIM);
    await seedEmbedded(2, DIM + 4, 3);

    await expect(ensureVectorIndex(DIM)).rejects.toThrow(/12 wide, but embedding.dimensions is 8/);
    expect(await indexNames()).not.toContain(VECTOR_INDEX_NAME);
  });

  it('does nothing at all when no endpoint is configured', async () => {
    await seedEmbedded(3);

    expect(await ensureVectorIndex(null)).toEqual({ status: 'unconfigured' });
    expect(await indexNames()).not.toContain(VECTOR_INDEX_NAME);
  });
});

async function indexNames(): Promise<string[]> {
  const rows = await getSequelize().query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'chunks'`,
    { type: QueryTypes.SELECT },
  );
  return rows.map((row) => row.indexname);
}
