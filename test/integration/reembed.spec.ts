import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { QueryTypes } from 'sequelize';

import { ConfigService } from '../../src/config/config.service';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { EMBEDDING_CLIENT } from '../../src/embed/embed.module';
import { EmbedService } from '../../src/embed/embed.service';
import { HybridSearch, KeywordSearch } from '../../src/content-reader/search/search.service';
import { reembed } from '../../src/embed/reembed';
import { hashingVector, stubEmbeddingClient } from '../helpers/embedding';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

const OLD = { model: 'old-model', dimensions: 16 };
const NEW = { model: 'new-model', dimensions: 24 };

let harness: Harness;
let app: INestApplication;
let ops: string;
let keyword: KeywordSearch;

function configFor(embedding: { model: string; dimensions: number }): ConfigService {
  const loaded = harness.config.loadedConfig;
  return new ConfigService({
    ...loaded,
    raw: {
      ...loaded.raw,
      embedding: { base_url: 'https://embeddings.example.test/v1', ...embedding },
    },
  } as unknown as typeof loaded);
}

async function counts(): Promise<{ current: number; stale: number; pending: number }> {
  return harness.reports.embeddingCoverage(harness.tenantId, NEW.model, NEW.dimensions);
}

async function embedWithOldModel(): Promise<void> {
  const stub = stubEmbeddingClient(OLD, hashingVector);
  const run = await new EmbedService(stub.client).embedPending(harness.tenantId);
  expect(run.embedded).toBeGreaterThan(0);
}

beforeAll(async () => {
  harness = await createHarness();
  ops = await sessionCookieFor(harness.tenantId, 'ops');
  keyword = new KeywordSearch(harness.search, harness.config);
});

afterAll(async () => {
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

beforeEach(async () => {
  await getSequelize().query(
    `UPDATE chunks SET embedding = NULL, embedding_model = NULL, embedding_dim = NULL`,
    { type: QueryTypes.UPDATE },
  );
});

describe('reembed', () => {
  it('clears the vectors and keeps every row, its text and its hash', async () => {
    await embedWithOldModel();
    const before = await getSequelize().query<{ id: string; text: string; content_hash: string }>(
      `SELECT id, text, content_hash FROM chunks ORDER BY id`,
      { type: QueryTypes.SELECT },
    );
    expect(before.length).toBeGreaterThan(0);

    const result = await reembed(harness.tenantId, configFor(NEW));

    const after = await getSequelize().query<{ id: string; text: string; content_hash: string }>(
      `SELECT id, text, content_hash FROM chunks ORDER BY id`,
      { type: QueryTypes.SELECT },
    );
    expect(after).toEqual(before);

    expect(result?.cleared).toBe(before.length);
    expect((await counts()).pending).toBe(before.length);
  });

  it('takes a new width without changing the schema', async () => {
    await embedWithOldModel();
    await reembed(harness.tenantId, configFor(NEW));
    await new EmbedService(stubEmbeddingClient(NEW, hashingVector).client).embedPending(
      harness.tenantId,
    );

    const widths = await getSequelize().query<{ embedding_dim: number }>(
      `SELECT DISTINCT embedding_dim FROM chunks WHERE embedding IS NOT NULL`,
      { type: QueryTypes.SELECT },
    );
    expect(widths.map((row) => row.embedding_dim)).toEqual([NEW.dimensions]);
  });

  it('hands the work to the job rather than doing it', async () => {
    await embedWithOldModel();
    await reembed(harness.tenantId, configFor(NEW));

    const jobs = await getSequelize().query<{ kind: string; status: string }>(
      `SELECT kind, status FROM jobs WHERE tenant_id = :tenantId AND kind = 'embed'`,
      { type: QueryTypes.SELECT, replacements: { tenantId: harness.tenantId } },
    );
    expect(jobs.length).toBeGreaterThan(0);
    expect((await counts()).current).toBe(0);
  });

  it('reaches a fully re-embedded state, and survives a restart half way', async () => {
    await embedWithOldModel();
    await reembed(harness.tenantId, configFor(NEW));

    const current = stubEmbeddingClient(NEW, hashingVector);

    const dying = new EmbedService(current.client);
    const killed = new Error('worker killed');
    let slices = 0;
    const real = current.client.embed.bind(current.client);
    jest.spyOn(current.client, 'embed').mockImplementation(async (texts) => {
      slices += 1;
      if (slices > 2) throw killed;
      return real(texts);
    });
    await expect(dying.embedPending(harness.tenantId)).rejects.toBe(killed);

    const half = await counts();
    expect(half.current).toBeGreaterThan(0);
    expect(half.pending).toBeGreaterThan(0);

    jest.restoreAllMocks();
    const restarted = stubEmbeddingClient(NEW, hashingVector);
    await new EmbedService(restarted.client).embedPending(harness.tenantId);

    const done = await counts();
    expect(done.pending).toBe(0);
    expect(done.stale).toBe(0);
    expect(done.current).toBe(await countChunks());
    expect(restarted.seen.length).toBe(half.pending);
  });

  it('never serves a mixed-model result set on the way', async () => {
    await embedWithOldModel();
    const current = stubEmbeddingClient(NEW, hashingVector);
    const hybrid = new HybridSearch(harness.search, harness.config, keyword, current.client);
    const bob = harness.caller('bob');
    const query = 'where things live in this repository';

    const beforeHits = await hybrid.search(bob, query);
    expect(beforeHits.map(keyOf)).toEqual((await keyword.search(bob, query)).map(keyOf));

    await reembed(harness.tenantId, configFor(NEW));

    const duringHits = await hybrid.search(bob, query);
    expect(duringHits.length).toBeGreaterThan(0);
    expect(duringHits).toEqual(await keyword.search(bob, query));

    await new EmbedService(current.client).embedPending(harness.tenantId);
    const semantic = await harness.search.searchSemantic(
      bob.principals,
      bob.tenantId,
      hashingVector(query, NEW.dimensions),
      NEW.model,
      NEW.dimensions,
    );
    expect(semantic.length).toBeGreaterThan(0);
    expect((await counts()).stale).toBe(0);
  });

  it('does nothing on an instance that configures no endpoint', async () => {
    await embedWithOldModel();
    const before = await counts();

    expect(await reembed(harness.tenantId, harness.config)).toBeNull();
    expect(await counts()).toEqual(before);
  });
});

describe('POST /-/reembed', () => {
  it('is the reader 404 for everyone who is not an admin', async () => {
    app = await bootTestApp(
      configFor(NEW),
      [],
      [{ token: EMBEDDING_CLIENT, value: stubEmbeddingClient(NEW, hashingVector).client }],
    );
    const alice = await sessionCookieFor(harness.tenantId, 'alice');

    await request(app.getHttpServer()).post('/-/reembed').set('cookie', alice).expect(404);
    await request(app.getHttpServer()).post('/-/reembed').expect(404);
    await app.close();
  });

  it('clears, enqueues, and tells each audience in its own shape', async () => {
    await embedWithOldModel();
    app = await bootTestApp(
      configFor(NEW),
      [],
      [{ token: EMBEDDING_CLIENT, value: stubEmbeddingClient(NEW, hashingVector).client }],
    );

    const json = await request(app.getHttpServer())
      .post('/-/reembed')
      .set('cookie', ops)
      .set('accept', 'application/json')
      .expect(200);
    expect(json.body.cleared).toBeGreaterThan(0);
    expect(json.body.model).toBe(NEW.model);
    expect((await counts()).current).toBe(0);

    const redirect = await request(app.getHttpServer())
      .post('/-/reembed')
      .set('cookie', ops)
      .expect(303);
    expect(redirect.headers.location).toMatch(/^\/-\/status\?reembedding=\d+$/);
    await app.close();
  });

  it('offers the button only where something is stale, and says so afterwards', async () => {
    await embedWithOldModel();
    app = await bootTestApp(
      configFor(NEW),
      [],
      [{ token: EMBEDDING_CLIENT, value: stubEmbeddingClient(NEW, hashingVector).client }],
    );

    const stale = await request(app.getHttpServer())
      .get('/-/status')
      .set('cookie', ops)
      .expect(200);
    expect(stale.text).toContain('/-/reembed');

    await request(app.getHttpServer()).post('/-/reembed').set('cookie', ops).expect(303);

    const cleared = await request(app.getHttpServer())
      .get('/-/status?reembedding=12')
      .set('cookie', ops)
      .expect(200);
    expect(cleared.text).not.toContain('/-/reembed');
    expect(cleared.text).toContain('Re-embedding 12 chunks');
    await app.close();
  });

  it('prints nothing for a caller-supplied count that is not one', async () => {
    app = await bootTestApp(
      configFor(NEW),
      [],
      [{ token: EMBEDDING_CLIENT, value: stubEmbeddingClient(NEW, hashingVector).client }],
    );
    const res = await request(app.getHttpServer())
      .get('/-/status?reembedding=<script>alert(1)</script>')
      .set('cookie', ops)
      .expect(200);

    expect(res.text).not.toContain('Re-embedding');
    expect(res.text).not.toContain('alert(1)');
    await app.close();
  });
});

function keyOf(hit: { repo_slug: string; slug_path: string }): string {
  return `${hit.repo_slug}:${hit.slug_path}`;
}

async function countChunks(): Promise<number> {
  const rows = await getSequelize().query<{ n: string }>(`SELECT count(*) AS n FROM chunks`, {
    type: QueryTypes.SELECT,
  });
  return Number(rows[0].n);
}
