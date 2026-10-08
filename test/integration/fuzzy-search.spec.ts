import { QueryTypes } from 'sequelize';

import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { KeywordSearch } from '../../src/content-reader/search/search.service';
import { Harness, createHarness } from '../helpers/harness';

let harness: Harness;
let keyword: KeywordSearch;

beforeAll(async () => {
  harness = await createHarness();
  keyword = new KeywordSearch(harness.search, harness.config);
});

afterAll(async () => {
  await harness?.close();
  await closeSequelize();
});

const TYPO = 'negotiatd';

const paths = (hits: { repo_slug: string; slug_path: string }[]) =>
  hits.map((h) => `${h.repo_slug}:${h.slug_path}`);

describe('a misspelled word in the body of a page', () => {
  it('finds the page, with the chunk that matched as its passage', async () => {
    const hits = await keyword.search(harness.caller('bob'), TYPO);
    const pricing = hits.find((h) => h.slug_path.endsWith('/pricing'));

    expect(pricing).toBeDefined();
    expect(pricing?.chunk_ord).not.toBeNull();
    expect(pricing?.chunk_text).toContain('negotiated');
    expect(pricing?.snippet).toContain('negotiated');
  });

  it('is no wider than the page route', async () => {
    for (const name of ['alice', 'mallory', 'anonymous'] as const) {
      const hits = await keyword.search(harness.caller(name), TYPO);
      expect(paths(hits).filter((p) => p.includes('commercial'))).toEqual([]);
    }
  });
});

describe("the typos pg_trgm's default threshold missed", () => {
  it.each(['quater', 'blened'])('finds "%s" in the body of the page', async (typo) => {
    const hits = await keyword.search(harness.caller('bob'), typo);
    expect(paths(hits)).toContain('handbook:commercial/pricing');
  });

  it('leaves the threshold where it found it', async () => {
    const caller = harness.caller('bob');
    await harness.search.searchTrigram(caller.principals, caller.tenantId, 'quater');
    const [row] = await getSequelize().query<{ t: string | null }>(
      "SELECT current_setting('pg_trgm.word_similarity_threshold', true) AS t",
      { type: QueryTypes.SELECT },
    );
    expect(row?.t ?? '0.6').not.toBe('0.5');
  });
});

describe('a misspelled query of several words', () => {
  it('matches the words one at a time, not the query as one string', async () => {
    const hits = await keyword.search(harness.caller('bob'), 'rate crad comercial');
    expect(paths(hits)).toContain('handbook:commercial/pricing');
  });
});

describe('full-text and fuzzy together', () => {
  it('returns every page either finds, not fuzzy only when full-text is empty', async () => {
    const caller = harness.caller('bob');
    const query = 'rate';
    const exact = await harness.search.searchKeyword(caller.principals, caller.tenantId, query);
    const fuzzy = await harness.search.searchTrigram(caller.principals, caller.tenantId, query);

    expect(exact.length).toBeGreaterThan(0);
    expect(fuzzy.length).toBeGreaterThan(0);

    const union = new Set([...paths(exact), ...paths(fuzzy)]);
    const combined = await keyword.candidates(caller, query, { limit: 100 });
    expect(new Set(paths(combined))).toEqual(union);
  });

  it('keeps the highlighted snippet of a page full-text found', async () => {
    const caller = harness.caller('bob');
    const hits = await keyword.candidates(caller, 'negotiated', { limit: 100 });
    const pricing = hits.find((h) => h.slug_path.endsWith('/pricing'));

    expect(pricing?.snippet).toContain('<mark>');
    expect(pricing?.chunk_text).toContain('negotiated');
  });
});

describe('the plan', () => {
  it('consults the trigram index on chunks', async () => {
    const sequelize = getSequelize();
    const [repo] = await sequelize.query<{ id: string }>(
      'SELECT id FROM repos WHERE tenant_id = :tenantId LIMIT 1',
      { type: QueryTypes.SELECT, replacements: { tenantId: harness.tenantId } },
    );
    await sequelize.query(
      `INSERT INTO chunks (tenant_id, repo_id, slug_path, ord, text, content_hash)
       SELECT :tenantId, :repoId, '/bulk/' || (i / 10), i % 10,
              'Filler paragraph ' || i || ' about deployments, rotas and onboarding ' || md5(i::text),
              md5(i::text)
         FROM generate_series(1, 20000) AS i`,
      { replacements: { tenantId: harness.tenantId, repoId: (repo as { id: string }).id } },
    );
    await sequelize.query('ANALYZE chunks');

    try {
      const spy = jest.spyOn(sequelize, 'query');
      const caller = harness.caller('bob');
      await harness.search.searchTrigram(caller.principals, caller.tenantId, `${TYPO} comercial`);
      const call = spy.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('FROM documents d'),
      );
      spy.mockRestore();
      const [sql, options] = call as unknown as [string, { replacements: Record<string, unknown> }];

      const rows = await sequelize.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, {
        type: QueryTypes.SELECT,
        replacements: options.replacements,
      });
      expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('chunks_text_trgm');
    } finally {
      await sequelize.query("DELETE FROM chunks WHERE slug_path LIKE '/bulk/%'");
      await sequelize.query('ANALYZE chunks');
    }
  });
});
