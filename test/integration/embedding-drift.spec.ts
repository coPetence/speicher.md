import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { QueryTypes } from 'sequelize';

import { ConfigService } from '../../src/config/config.service';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { EmbedService } from '../../src/embed/embed.service';
import { HybridSearch, KeywordSearch } from '../../src/content-reader/search/search.service';
import { hashingVector, stubEmbeddingClient } from '../helpers/embedding';
import { Harness, createHarness, resetVectorIndex } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

const DIMENSIONS = 32;

let harness: Harness;
let app: INestApplication;
let ops: string;
let keyword: KeywordSearch;

beforeAll(async () => {
  harness = await createHarness();
  ops = await sessionCookieFor(harness.tenantId, 'ops');
  keyword = new KeywordSearch(harness.search, harness.config);
});

afterAll(async () => {
  await resetVectorIndex();
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

beforeEach(async () => {
  await getSequelize().query(
    `UPDATE chunks SET embedding = NULL, embedding_model = NULL, embedding_dim = NULL`,
    {
      type: QueryTypes.UPDATE,
    },
  );
  await resetVectorIndex();
});

async function embedWith(model: string, dimensions = DIMENSIONS) {
  const stub = stubEmbeddingClient({ model, dimensions }, hashingVector);
  const run = await new EmbedService(stub.client).embedPending(harness.tenantId);
  expect(run.embedded).toBeGreaterThan(0);
  return stub;
}

describe('a model the instance no longer runs', () => {
  const QUERY = 'rate card for commercial clients';

  it('never lets a chunk from another model into a result set', async () => {
    await embedWith('old-model');

    const semantic = await harness.search.searchSemantic(
      harness.caller('bob').principals,
      harness.tenantId,
      hashingVector(QUERY, DIMENSIONS),
      'new-model',
      DIMENSIONS,
    );
    expect(semantic).toEqual([]);

    expect(
      await harness.search.searchSemantic(
        harness.caller('bob').principals,
        harness.tenantId,
        hashingVector(QUERY, DIMENSIONS),
        'old-model',
        DIMENSIONS + 8,
      ),
    ).toEqual([]);
  });

  it('serves keyword results rather than nothing', async () => {
    await embedWith('old-model');
    const current = stubEmbeddingClient(
      { model: 'new-model', dimensions: DIMENSIONS },
      hashingVector,
    );
    const hybrid = new HybridSearch(harness.search, harness.config, keyword, current.client);
    const bob = harness.caller('bob');

    const hits = await hybrid.search(bob, QUERY);
    expect(hits.map((h) => `${h.repo_slug}:${h.slug_path}`)).toEqual(
      (await keyword.search(bob, QUERY)).map((h) => `${h.repo_slug}:${h.slug_path}`),
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  it('does not quietly re-embed them, which is why a re-embed has to be explicit', async () => {
    await embedWith('old-model');
    const current = stubEmbeddingClient(
      { model: 'new-model', dimensions: DIMENSIONS },
      hashingVector,
    );

    const second = await new EmbedService(current.client).embedPending(harness.tenantId);
    expect(second.embedded).toBe(0);

    const hybrid = new HybridSearch(harness.search, harness.config, keyword, current.client);
    expect(await hybrid.search(harness.caller('bob'), QUERY)).toEqual(
      await keyword.search(harness.caller('bob'), QUERY),
    );

    await getSequelize().query(
      `UPDATE chunks SET embedding = NULL, embedding_model = NULL, embedding_dim = NULL
        WHERE embedding_model = 'old-model'`,
      { type: QueryTypes.UPDATE },
    );
    const third = await new EmbedService(current.client).embedPending(harness.tenantId);
    expect(third.embedded).toBeGreaterThan(0);

    const semantic = await harness.search.searchSemantic(
      harness.caller('bob').principals,
      harness.tenantId,
      hashingVector(QUERY, DIMENSIONS),
      'new-model',
      DIMENSIONS,
    );
    expect(semantic.length).toBeGreaterThan(0);
  });
});

describe('/-/status names the mismatch', () => {
  async function statusJson(): Promise<Record<string, any>> {
    const res = await request(app.getHttpServer())
      .get('/-/status')
      .set('cookie', ops)
      .set('accept', 'application/json')
      .expect(200);
    return res.body;
  }

  async function statusPage(): Promise<string> {
    const res = await request(app.getHttpServer()).get('/-/status').set('cookie', ops).expect(200);
    // The page, not the column: the column names the settings page of that title.
    return res.text.slice(res.text.indexOf('<main'), res.text.indexOf('</main>'));
  }

  it('says nothing at all on an instance that configures no endpoint', async () => {
    app = await bootTestApp();
    const body = await statusJson();

    expect(body.instance.embedding).toBeNull();
    expect(await statusPage()).not.toContain('Semantic retrieval');
    await app.close();
  });

  it('counts what is current, what is stale and what is pending', async () => {
    await embedWith('old-model');

    const loaded = harness.config.loadedConfig;
    const configured = new ConfigService({
      ...loaded,
      raw: {
        ...loaded.raw,
        embedding: {
          base_url: 'https://embeddings.example.test/v1',
          model: 'new-model',
          dimensions: DIMENSIONS,
        },
      },
    } as unknown as typeof loaded);

    await getSequelize().query(
      `UPDATE chunks SET embedding = NULL, embedding_model = NULL, embedding_dim = NULL
        WHERE id = (SELECT id FROM chunks ORDER BY id LIMIT 1)`,
      { type: QueryTypes.UPDATE },
    );

    app = await bootTestApp(configured);
    const body = await statusJson();

    expect(body.instance.embedding.model).toBe('new-model');
    expect(body.instance.embedding.current).toBe(0);
    expect(body.instance.embedding.stale).toBeGreaterThan(0);
    expect(body.instance.embedding.pending).toBe(1);

    const page = await statusPage();
    expect(page).toContain('Semantic retrieval');
    expect(page).toContain('on another model');
    expect(page).toContain(`${body.instance.embedding.stale} on another model`);
    await app.close();
  });

  it('is admin-only, like everything else in the instance summary', async () => {
    app = await bootTestApp();
    const alice = await sessionCookieFor(harness.tenantId, 'alice');

    const res = await request(app.getHttpServer())
      .get('/-/status')
      .set('cookie', alice)
      .set('accept', 'application/json')
      .expect(200);

    expect(res.body.scope).toBe('maintainer');
    expect(res.body.instance).toBeNull();
    await app.close();
  });
});
