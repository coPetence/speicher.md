import { QueryTypes } from 'sequelize';

import { Chunk } from '../../src/db/models';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { parseVector, toVectorLiteral } from '../../src/db/vector';
import { Harness, createHarness } from '../helpers/harness';

let harness: Harness;
let page: { repo_id: string; slug_path: string };

beforeAll(async () => {
  harness = await createHarness();
  const [row] = await getSequelize().query<{ repo_id: string; slug_path: string }>(
    `SELECT repo_id, slug_path FROM documents WHERE tenant_id = :tenant ORDER BY slug_path LIMIT 1`,
    { type: QueryTypes.SELECT, replacements: { tenant: harness.tenantId } },
  );
  page = row;
});

afterAll(async () => {
  await harness?.close();
  await closeSequelize();
});

describe('Chunk.embedding', () => {
  const embedding = [0.5, -0.25, 0, 1];

  function row(ord: number, hash: string, extra: Record<string, unknown> = {}) {
    return {
      tenant_id: harness.tenantId,
      repo_id: page.repo_id,
      slug_path: `spec-only/${hash}`,
      ord,
      text: 'a chunk',
      content_hash: hash,
      ...extra,
    };
  }

  it('round-trips as an array of numbers', async () => {
    const written = await Chunk.create(
      row(0, 'hash-round-trip', { embedding, embedding_model: 'test-model', embedding_dim: 4 }),
    );

    expect(written.embedding).toEqual(embedding);

    const read = await Chunk.findOne({ where: { content_hash: 'hash-round-trip' } });
    expect(read?.embedding).toEqual(embedding);
  });

  it('stores a vector rather than its text, so pgvector operators apply', async () => {
    await Chunk.create(row(0, 'hash-operator', { embedding, embedding_dim: 4 }));

    const [distance] = await getSequelize().query<{ distance: number }>(
      `SELECT embedding <-> :probe::vector AS distance FROM chunks WHERE content_hash = 'hash-operator'`,
      { type: QueryTypes.SELECT, replacements: { probe: toVectorLiteral(embedding) } },
    );
    expect(Number(distance.distance)).toBe(0);
  });

  it('keeps null as null', async () => {
    await Chunk.create(row(0, 'hash-null'));
    const read = await Chunk.findOne({ where: { content_hash: 'hash-null' } });
    expect(read?.embedding).toBeNull();
  });

  it('refuses a value that is not a vector', async () => {
    await expect(Chunk.create(row(0, 'hash-bad', { embedding: ['nope'] }))).rejects.toThrow(
      /not a valid vector/,
    );
  });
});

describe('parseVector', () => {
  it('reads the printed form and passes an array through', () => {
    expect(parseVector('[1,2,3]')).toEqual([1, 2, 3]);
    expect(parseVector([1, 2, 3])).toEqual([1, 2, 3]);
    expect(parseVector('[]')).toEqual([]);
    expect(parseVector(null)).toBeNull();
    expect(parseVector(undefined)).toBeNull();
  });
});
