import { QueryTypes } from 'sequelize';

import { EMBED_BUDGET_MS, EmbedService } from '../../src/embed/embed.service';
import { Forge, Repo } from '../../src/db/models';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { STUB_DIMENSIONS, stubEmbeddingClient, vectorFor } from '../helpers/embedding';
import { Harness, createHarness, resetVectorIndex } from '../helpers/harness';

let harness: Harness;
let repoId: string;
let tenantId: string;

beforeAll(async () => {
  harness = await createHarness();
  tenantId = harness.tenantId;
  await resetVectorIndex();

  const forge = await Forge.findOne({ where: { tenant_id: tenantId } });
  const repo = await Repo.create({
    tenant_id: tenantId,
    forge_id: (forge as Forge).id,
    forge_repo_id: '41775321',
    namespace: 'copetence',
    namespace_id: '9001',
    slug: 'embedded',
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

async function seedChunks(count: number): Promise<void> {
  for (let ord = 0; ord < count; ord += 1) {
    await getSequelize().query(
      `INSERT INTO chunks (tenant_id, repo_id, slug_path, ord, text, content_hash)
       VALUES (:tenantId, :repoId, 'page', :ord, :text, :hash)`,
      {
        type: QueryTypes.INSERT,
        replacements: { tenantId, repoId, ord, text: `chunk ${ord}`, hash: `hash-${ord}` },
      },
    );
  }
}

interface Row {
  ord: number;
  text: string;
  embedding: string | null;
  embedding_model: string | null;
  embedding_dim: number | null;
}

async function rows(): Promise<Row[]> {
  return getSequelize().query<Row>(
    `SELECT ord, text, embedding::text AS embedding, embedding_model, embedding_dim
       FROM chunks WHERE repo_id = :repoId ORDER BY ord`,
    { type: QueryTypes.SELECT, replacements: { repoId } },
  );
}

describe('embedPending', () => {
  it('embeds every pending chunk and writes the three columns together', async () => {
    await seedChunks(5);
    const endpoint = stubEmbeddingClient();
    const service = new EmbedService(endpoint.client);

    const run = await service.embedPending(tenantId);
    expect(run).toEqual({ embedded: 5, remaining: 0, exhausted: false });

    const written = await rows();
    for (const row of written) {
      expect(row.embedding).not.toBeNull();
      expect(row.embedding_model).toBe('stub-embed');
      expect(row.embedding_dim).toBe(STUB_DIMENSIONS);
    }
    expect(written.map((r) => JSON.parse(r.embedding as string)[0])).toEqual(
      written.map((r) => vectorFor(r.text)[0]),
    );
  });

  it('does nothing, cheaply, when every chunk already has one', async () => {
    await seedChunks(4);
    const first = stubEmbeddingClient();
    await new EmbedService(first.client).embedPending(tenantId);

    const second = stubEmbeddingClient();
    const run = await new EmbedService(second.client).embedPending(tenantId);

    expect(run.embedded).toBe(0);
    expect(second.seen).toEqual([]);
  });

  it('resumes after a run dies, without paying for a chunk twice', async () => {
    await seedChunks(8);

    const dying = stubEmbeddingClient();
    const killed = new Error('worker killed');
    let batches = 0;
    const realClient = dying.client;
    const embed = realClient.embed.bind(realClient);
    jest.spyOn(realClient, 'embed').mockImplementation(async (texts) => {
      batches += 1;
      if (batches > 1) throw killed;
      return embed(texts);
    });
    await expect(new EmbedService(realClient).embedPending(tenantId)).rejects.toBe(killed);

    const partial = (await rows()).filter((r) => r.embedding !== null);
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(8);
    const banked = partial.map((r) => r.text);

    const restarted = stubEmbeddingClient();
    const run = await new EmbedService(restarted.client).embedPending(tenantId);

    expect(run.embedded).toBe(8 - banked.length);
    expect((await rows()).every((r) => r.embedding !== null)).toBe(true);
    for (const text of banked) expect(restarted.seen).not.toContain(text);
  });

  it('hands back when the budget is spent, rather than outliving its claim', async () => {
    await seedChunks(6);
    const endpoint = stubEmbeddingClient({ batch_size: 1, max_concurrency: 1 });

    let calls = 0;
    const clock = () => {
      calls += 1;
      return calls > 2 ? EMBED_BUDGET_MS + 1 : 0;
    };
    const run = await new EmbedService(endpoint.client, getSequelize(), clock).embedPending(
      tenantId,
    );

    expect(run.exhausted).toBe(true);
    expect(run.embedded).toBeGreaterThan(0);
    expect(run.remaining).toBeGreaterThan(0);
    expect(run.embedded + run.remaining).toBe(6);
  });

  it('throws on a permanently failing endpoint, so the queue can dead-letter it', async () => {
    await seedChunks(3);
    const endpoint = stubEmbeddingClient();
    endpoint.breakWith(500);

    await expect(new EmbedService(endpoint.client).embedPending(tenantId)).rejects.toFailWith(
      'embedding.http-status',
      { status: 500 },
    );
    expect((await rows()).every((r) => r.embedding === null)).toBe(true);
  });

  it('refuses a model that changes width mid-run', async () => {
    await seedChunks(2);
    const endpoint = stubEmbeddingClient({ dimensions: STUB_DIMENSIONS + 1 });

    await expect(new EmbedService(endpoint.client).embedPending(tenantId)).rejects.toFailWith(
      'embedding.dimension-mismatch',
      { returned: 3, configured: 4 },
    );
    expect((await rows()).every((r) => r.embedding === null)).toBe(true);
  });

  it('is a no-op on an instance that configured no endpoint', async () => {
    await seedChunks(2);
    const service = new EmbedService(null);

    expect(service.configured).toBe(false);
    expect(await service.embedPending(tenantId)).toEqual({
      embedded: 0,
      remaining: 0,
      exhausted: false,
    });
    expect((await rows()).every((r) => r.embedding === null)).toBe(true);
  });
});
