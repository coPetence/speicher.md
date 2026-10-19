import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { SearchHit } from '../../src/authz/content/types';
import { closeSequelize } from '../../src/db/sequelize';
import { EmbedService } from '../../src/embed/embed.service';
import { DEFAULT_ICONS } from '../../src/content-reader/icons';
import { HybridSearch, KeywordSearch } from '../../src/content-reader/search/search.service';
import { hashingVector, stubEmbeddingClient } from '../helpers/embedding';
import { Harness, PrincipalName, createHarness, resetVectorIndex } from '../helpers/harness';
import { apiKeyFor, bootTestApp, sessionCookieFor } from '../helpers/http';

let app: INestApplication;
let harness: Harness;
const cookies: Partial<Record<PrincipalName | 'anonymous', string>> = {};

const PATHS = [
  '/handbook/',
  '/handbook/introduction',
  '/handbook/setup',
  '/handbook/where-things-live',
  '/handbook/troubleshooting',
  '/handbook/commercial',
  '/handbook/commercial/pricing',
  '/handbook/commercial/legal',
  '/handbook/commercial/legal/contracts',
  '/handbook/commercial/images/chart.jpg',
  '/handbook/northwind',
  '/handbook/northwind/handover',
  '/northwind-engineering/specs/',
  '/northwind-engineering/specs/tolerances',
  '/speicher-docs/',
  '/speicher-docs/getting-started',
  '/speicher-docs/diagram.png',
  '/speicher-docs/internal',
  '/speicher-docs/internal/roadmap',
] as const;

type Path = (typeof PATHS)[number];

const VISIBLE: Record<PrincipalName | 'anonymous', Path[]> = {
  alice: [
    '/handbook/',
    '/handbook/introduction',
    '/handbook/setup',
    '/handbook/where-things-live',
    '/handbook/troubleshooting',
    '/speicher-docs/',
    '/speicher-docs/getting-started',
    '/speicher-docs/diagram.png',
    '/speicher-docs/internal',
    '/speicher-docs/internal/roadmap',
  ],
  bob: [
    '/handbook/',
    '/handbook/introduction',
    '/handbook/setup',
    '/handbook/where-things-live',
    '/handbook/troubleshooting',
    '/handbook/commercial',
    '/handbook/commercial/pricing',
    '/handbook/commercial/images/chart.jpg',
    '/speicher-docs/',
    '/speicher-docs/getting-started',
    '/speicher-docs/diagram.png',
  ],
  carol: [
    '/handbook/',
    '/handbook/introduction',
    '/handbook/setup',
    '/handbook/where-things-live',
    '/handbook/troubleshooting',
    '/handbook/northwind',
    '/handbook/northwind/handover',
    '/northwind-engineering/specs/',
    '/northwind-engineering/specs/tolerances',
    '/speicher-docs/',
    '/speicher-docs/getting-started',
    '/speicher-docs/diagram.png',
  ],
  dave: [
    '/handbook/',
    '/handbook/introduction',
    '/handbook/setup',
    '/handbook/where-things-live',
    '/handbook/troubleshooting',
    '/speicher-docs/',
    '/speicher-docs/getting-started',
    '/speicher-docs/diagram.png',
  ],
  ops: ['/speicher-docs/', '/speicher-docs/getting-started', '/speicher-docs/diagram.png'],
  mallory: ['/speicher-docs/', '/speicher-docs/getting-started', '/speicher-docs/diagram.png'],
  anonymous: ['/speicher-docs/', '/speicher-docs/getting-started', '/speicher-docs/diagram.png'],
};

beforeAll(async () => {
  harness = await createHarness();
  app = await bootTestApp();
  for (const name of ['alice', 'bob', 'carol', 'dave', 'ops', 'mallory'] as PrincipalName[]) {
    cookies[name] = await sessionCookieFor(harness.tenantId, name);
  }
});

afterAll(async () => {
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

function as(who: PrincipalName | 'anonymous') {
  const agent = request(app.getHttpServer());
  const cookie = who === 'anonymous' ? undefined : cookies[who];
  return {
    get(path: string) {
      const req = agent.get(path);
      return cookie ? req.set('Cookie', cookie) : req;
    },
  };
}

const EVERYONE: (PrincipalName | 'anonymous')[] = [
  'alice',
  'bob',
  'carol',
  'dave',
  'ops',
  'mallory',
  'anonymous',
];

describe('page route: 200 or 404, never 403, never content', () => {
  for (const who of EVERYONE) {
    for (const path of PATHS) {
      const shouldSee = VISIBLE[who].includes(path);
      it(`${who} ${shouldSee ? 'sees' : 'cannot see'} ${path}`, async () => {
        const res = await as(who).get(path);
        expect(res.status).toBe(shouldSee ? 200 : 404);
        expect(res.status).not.toBe(403);
      });
    }
  }

  it('never leaks restricted body text into a 404', async () => {
    const res = await as('alice').get('/handbook/commercial/pricing');
    expect(res.status).toBe(404);
    expect(res.text).not.toMatch(/Rate cards/i);
    expect(res.text).not.toMatch(/Pricing/i);
  });

  it('404s the folder that intersects to nobody, for every principal', async () => {
    for (const who of EVERYONE) {
      const res = await as(who).get('/handbook/commercial/legal');
      expect(res.status).toBe(404);
    }
  });

  it('404s /handbook/index rather than duplicating the landing page', async () => {
    const res = await as('alice').get('/handbook/index');
    expect(res.status).toBe(404);
  });

  it('serves a reader with no credential the whole page, and offers sign-in', async () => {
    const res = await as('anonymous').get('/speicher-docs/getting-started');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Point Speicher at a repository');
    expect(res.text).toContain('class="spr-signin"');
    expect(res.text).not.toMatch(/roadmap|handbook/i);
  });

  it('keeps the response private to the reader, public content or not', async () => {
    const res = await as('anonymous').get('/speicher-docs/getting-started');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});

describe('folder listing: restricted children absent by name', () => {
  it('omits the commercial folder from the root listing for engineering', async () => {
    const res = await as('alice').get('/handbook/');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('commercial');
    expect(res.text).not.toContain('Commercial');
  });

  it('includes the commercial folder for a commercial reader', async () => {
    const res = await as('bob').get('/handbook/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Commercial');
  });

  it('never lists the legal folder, which nobody can read', async () => {
    for (const who of ['alice', 'bob', 'carol', 'dave', 'ops'] as PrincipalName[]) {
      const res = await as(who).get('/handbook/commercial');
      if (res.status !== 200) continue;
      expect(res.text).not.toContain('legal');
      expect(res.text).not.toContain('Legal');
    }
  });

  it('omits the northwind folder for everyone outside client-northwind', async () => {
    for (const who of ['alice', 'bob', 'dave'] as PrincipalName[]) {
      const res = await as(who).get('/handbook/');
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('Northwind');
    }
  });
});

describe('nav tree: same filtering as the listing', () => {
  it('does not name a restricted folder anywhere in the page', async () => {
    const res = await as('alice').get('/handbook/introduction');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Commercial');
    expect(res.text).not.toContain('Northwind');
  });

  it('names the folders a permitted reader can open', async () => {
    const res = await as('carol').get('/handbook/introduction');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Northwind Engineering');
    expect(res.text).not.toContain('Commercial');
  });
});

describe('related column and tags: same filtering as every other surface', () => {
  const RESTRICTED: [name: string, keptFrom: (PrincipalName | 'anonymous')[]][] = [
    ['Contracts', EVERYONE],
    ['commercial/legal', EVERYONE],
    ['Pricing', ['alice', 'carol', 'dave', 'ops', 'mallory', 'anonymous']],
    ['Handover', ['alice', 'bob', 'dave', 'ops', 'mallory', 'anonymous']],
  ];

  for (const who of EVERYONE) {
    it(`names nothing restricted in any aside ${who} can reach`, async () => {
      for (const path of PATHS) {
        if (!VISIBLE[who].includes(path)) continue;
        const res = await as(who).get(path);
        if (res.status !== 200) continue;
        const column = /<aside class="spr-aside"[\s\S]*?<\/aside>/.exec(res.text)?.[0] ?? '';
        for (const [name, keptFrom] of RESTRICTED) {
          if (keptFrom.includes(who)) expect(column).not.toContain(name);
        }
      }
    });
  }

  it('gives a tag listing exactly the pages the page route would', async () => {
    for (const who of EVERYONE) {
      const res = await as(who).get('/?tag=handbook');
      if (res.status === 404) continue;
      for (const href of [...res.text.matchAll(/<a href="(\/handbook\/[^"#?]*)"/g)].map(
        (m) => m[1],
      )) {
        expect((await as(who).get(href)).status).toBe(200);
      }
    }
  });
});

describe('site root: repos with nothing visible are absent', () => {
  it('shows only the handbook to engineering', async () => {
    const res = await as('alice').get('/');
    expect(res.text).toContain('coPetence Handbook');
    expect(res.text).not.toContain('Northwind Specifications');
  });

  it('shows both repos to client-northwind', async () => {
    const res = await as('carol').get('/');
    expect(res.text).toContain('coPetence Handbook');
    expect(res.text).toContain('Northwind Specifications');
  });

  it('shows nothing to an admin who holds no content grant', async () => {
    const res = await as('ops').get('/');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('coPetence Handbook');
    expect(res.text).not.toContain('Northwind Specifications');
  });
});

describe('site root: covers are as visible as the bytes behind them', () => {
  it('draws the declared cover for a caller who may fetch it', async () => {
    const res = await as('alice').get('/');
    expect(res.text).toContain('<img src="/handbook/_repo/cover.jpg"');
    expect((await as('alice').get('/handbook/_repo/cover.jpg')).status).toBe(200);
  });

  it('never points at bytes the caller may not have', async () => {
    for (const who of ['alice', 'bob', 'carol', 'dave'] as const) {
      const res = await as(who).get('/');
      const sources = [...res.text.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
      for (const src of sources) expect((await as(who).get(src)).status).toBe(200);
    }
  });

  it('falls back to the default tile when the cover resolves to nobody', async () => {
    const res = await as('carol').get('/');
    expect(res.text).toContain('Northwind Specifications');
    expect(res.text).not.toContain('/northwind-engineering/specs/internal/cover.png');
    expect(res.text).toMatch(/<svg class="spr-cover-art"[^>]*data-spr-pattern="scales"/);
  });

  it('gives a repository with no cover the tile its name resolves to', async () => {
    const first = await as('alice').get('/');
    const second = await as('alice').get('/');
    const tiles = (text: string) =>
      [...text.matchAll(/data-spr-pattern="([a-z]+)"/g)].map((m) => m[1]);
    expect(tiles(first.text)).toEqual(tiles(second.text));
    expect(tiles(first.text)).toEqual(['dots', 'crosses', 'crosses']);
  });

  it('draws the tile behind a declared cover, for the browser to fall back to', async () => {
    const res = await as('alice').get('/');
    expect(res.text).toMatch(
      /<img src="\/handbook\/_repo\/cover\.jpg"[^>]*>\s*<svg class="spr-cover-art"/,
    );
    expect(res.text).toMatch(/<script type="module" nonce="[^"]+" src="\/-\/static\/covers-/);
    expect(res.text).not.toMatch(/src="\/-\/static\/tree-/);
  });

  it('gives each card its own pattern element, so two tiles cannot collide', async () => {
    const res = await as('carol').get('/');
    const ids = [...res.text.matchAll(/<pattern id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('a cover is the repository’s picture, on its landing page alone', () => {
  it('draws it on the landing page, in the box the overview card uses', async () => {
    const res = await as('alice').get('/handbook/');
    // The card's own class, so one stylesheet rule crops both: a card is a claim
    // about the page it leads to.
    expect(res.text).toContain('class="spr-cover spr-cover-page"');
    const src = /<img src="(\/handbook\/_repo\/[^"]+)"/.exec(res.text)?.[1];
    expect(src).toBeDefined();
    expect((await as('alice').get(src!)).status).toBe(200);
  });

  it('draws it on no other page, and on no folder below the root', async () => {
    for (const path of [
      '/handbook/introduction',
      '/handbook/setup',
      '/handbook/where-things-live',
    ] as const) {
      const res = await as('alice').get(path);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('spr-cover');
    }
    // A generated folder listing is the landing page only at the root.
    const folder = await as('carol').get('/handbook/northwind');
    expect(folder.status).toBe(200);
    expect(folder.text).not.toContain('spr-cover');
  });

  it('withholds a cover whose bytes the caller may not have, box and all', async () => {
    // `specs` declares its cover inside `docs/internal/`, which resolves to
    // nobody. The path alone would put a restricted folder's *name* at the top of
    // the page for every reader of the repository — rule 3 lost to a decoration.
    // Nothing is drawn, so there is no tile to fall back to either: a repository
    // whose cover this caller cannot read looks like one that never had a cover.
    const res = await as('carol').get('/northwind-engineering/specs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Northwind Specifications');
    expect(res.text).not.toContain('spr-cover');
    expect(res.text).not.toContain('internal/cover');
  });
});

describe('search: no title, snippet or path', () => {
  it('finds a permitted page', async () => {
    const res = await as('bob').get('/?q=pricing');
    expect(res.status).toBe(200);
    expect(res.text).toContain('/handbook/commercial/pricing');
  });

  it('returns nothing about a restricted page to an unpermitted reader', async () => {
    const res = await as('alice').get('/?q=pricing');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('/handbook/commercial/pricing');
    expect(res.text).not.toContain('Rate card');
  });

  it('never surfaces the second repo across the tenant boundary of access', async () => {
    const res = await as('bob').get('/?q=tolerances');
    expect(res.text).not.toContain('Tolerances');
    expect(res.text).not.toContain('/northwind-engineering/specs/tolerances');
  });

  it('returns the page nobody can read to nobody', async () => {
    for (const who of EVERYONE) {
      const res = await as(who).get('/?q=contracts');
      expect(res.text).not.toContain('/handbook/commercial/legal/contracts');
    }
  });

  it('draws the block a hit landed in as the page draws it, under the same filter', async () => {
    const res = await as('alice').get('/?q=slug_path');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(
      /<div class="spr-excerpt"><pre><code[^>]*>[^<]*<mark>slug_path<\/mark>/,
    );
    expect(res.text).toMatch(/href="\/handbook\/introduction#:~:text=[^"]*slug_path[^"]*"/);
    const restricted = await as('alice').get('/?q=negotiated');
    expect(restricted.text).not.toContain('spr-excerpt');
  });

  it('still returns a page marked indexable false — that flag governs AI retrieval only', async () => {
    const res = await as('alice').get('/?q=troubleshooting');
    expect(res.text).toContain('/handbook/troubleshooting');
  });
});

describe('semantic retrieval: the same filter, on the surface that leaks quietly', () => {
  const DIMENSIONS = 64;

  const DOCUMENTS: Partial<Record<Path, { repo: string; slug: string }>> = {
    '/handbook/': { repo: 'handbook', slug: '' },
    '/northwind-engineering/specs/': { repo: 'specs', slug: '' },
    '/handbook/commercial': { repo: 'handbook', slug: 'commercial' },
    '/handbook/commercial/legal': { repo: 'handbook', slug: 'commercial/legal' },
    '/handbook/northwind': { repo: 'handbook', slug: 'northwind' },
    '/handbook/introduction': { repo: 'handbook', slug: 'introduction' },
    '/handbook/setup': { repo: 'handbook', slug: 'setup' },
    '/handbook/where-things-live': { repo: 'handbook', slug: 'where-things-live' },
    '/handbook/troubleshooting': { repo: 'handbook', slug: 'troubleshooting' },
    '/handbook/commercial/pricing': { repo: 'handbook', slug: 'commercial/pricing' },
    '/handbook/commercial/legal/contracts': {
      repo: 'handbook',
      slug: 'commercial/legal/contracts',
    },
    '/handbook/northwind/handover': { repo: 'handbook', slug: 'northwind/handover' },
    '/northwind-engineering/specs/tolerances': { repo: 'specs', slug: 'tolerances' },
  };

  const QUERIES = [
    'pricing rate card commercial',
    'tolerances engineering specification',
    'contracts legal agreement',
    'handover northwind client',
    'introduction ordering numeric prefixes',
    'troubleshooting when a sync fails',
    'where things live',
    'setup',
  ];

  let hybrid: HybridSearch;
  let keyword: KeywordSearch;
  let stub: ReturnType<typeof stubEmbeddingClient>;

  function keyOf(hit: SearchHit): string {
    return `${hit.repo_slug}:${hit.slug_path}`;
  }

  function urlOf(hit: SearchHit): string {
    const repo =
      hit.repo_namespace === 'copetence'
        ? `/${hit.repo_slug}`
        : `/${hit.repo_namespace}/${hit.repo_slug}`;
    return hit.slug_path === '' ? `${repo}/` : `${repo}/${hit.slug_path}`;
  }

  beforeAll(async () => {
    stub = stubEmbeddingClient({ dimensions: DIMENSIONS }, hashingVector);
    keyword = new KeywordSearch(harness.search, harness.config);
    hybrid = new HybridSearch(harness.search, harness.config, keyword, stub.client);

    const run = await new EmbedService(stub.client).embedPending(harness.tenantId);
    expect(run.embedded).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await resetVectorIndex();
  });

  it('retrieves a page by meaning, so the negative assertions are not vacuous', async () => {
    const hits = await hybrid.search(harness.caller('bob'), 'rate card for commercial clients');
    expect(hits.map(keyOf)).toContain('handbook:commercial/pricing');

    const semantic = await harness.search.searchSemantic(
      harness.caller('bob').principals,
      harness.tenantId,
      hashingVector('rate card for commercial clients', DIMENSIONS),
      stub.client.model,
      DIMENSIONS,
    );
    expect(semantic.map(keyOf)).toContain('handbook:commercial/pricing');
    expect(semantic[0].snippet.length).toBeGreaterThan(0);
  });

  it('never returns a chunk of a page the reader cannot open', async () => {
    for (const who of EVERYONE) {
      const seen = new Set<string>();
      for (const query of QUERIES) {
        for (const hit of await hybrid.search(harness.caller(who), query, {
          retrievalOnly: true,
        })) {
          seen.add(urlOf(hit));
        }
      }
      expect({ who, any: seen.size > 0 }).toEqual({
        who,
        any: VISIBLE[who].length > 0,
      });

      for (const url of seen) {
        const res = await as(who).get(url);
        expect({ who, url, status: res.status }).toEqual({ who, url, status: 200 });
      }
    }
  });

  it('decides by the principals it was given, not by the query', async () => {
    const query = hashingVector('rate card for commercial clients', DIMENSIONS);
    const forBob = await harness.search.searchSemantic(
      harness.caller('bob').principals,
      harness.tenantId,
      query,
      stub.client.model,
      DIMENSIONS,
    );
    const forAlice = await harness.search.searchSemantic(
      harness.caller('alice').principals,
      harness.tenantId,
      query,
      stub.client.model,
      DIMENSIONS,
    );

    expect(forBob.map(keyOf)).toContain('handbook:commercial/pricing');
    expect(forAlice.map(keyOf)).not.toContain('handbook:commercial/pricing');
    expect(forAlice.length).toBeGreaterThan(0);
  });

  it('withholds every restricted page from every reader it is restricted from', async () => {
    for (const who of EVERYONE) {
      const visible = new Set<string>(VISIBLE[who]);
      const withheld = (Object.keys(DOCUMENTS) as Path[]).filter((p) => !visible.has(p));

      const found = new Set<string>();
      for (const query of QUERIES) {
        for (const hit of await hybrid.search(harness.caller(who), query)) found.add(keyOf(hit));
      }
      for (const path of withheld) {
        const doc = DOCUMENTS[path] as { repo: string; slug: string };
        expect({ who, path, found: found.has(`${doc.repo}:${doc.slug}`) }).toEqual({
          who,
          path,
          found: false,
        });
      }
    }
  });

  it('escapes the passage it hands the reader, and not the one it hands an agent', async () => {
    const hits = await harness.search.searchSemantic(
      harness.caller('alice').principals,
      harness.tenantId,
      hashingVector('an image from a narrower folder renders as broken', DIMENSIONS),
      stub.client.model,
      DIMENSIONS,
    );
    const withMarkup = hits.find((hit) => (hit.chunk_text as string).includes('<'));
    expect(withMarkup).toBeDefined();

    const hit = withMarkup as SearchHit;
    expect(hit.snippet).toContain('&lt;');
    expect(hit.snippet).not.toMatch(/<[a-z]/i);
    expect(hit.chunk_text).toContain('<');
  });

  it('escapes the keyword snippet too, since ts_headline does not', async () => {
    const hits = await harness.search.searchKeyword(
      harness.caller('alice').principals,
      harness.tenantId,
      'broken image html bytes',
    );
    const hit = hits.find((h) => h.slug_path === 'where-things-live');
    expect(hit).toBeDefined();
    const snippet = (hit as SearchHit).snippet;
    expect(snippet).toContain('&lt;img');
    expect(snippet.replace(/<\/?mark>/g, '')).not.toMatch(/<[a-z]/i);
  });

  it('returns nothing at all to a caller with no principals', async () => {
    const nobody = { ...harness.caller('mallory'), principals: [] };
    for (const query of QUERIES) {
      expect(await hybrid.search(nobody, query)).toEqual([]);
    }
    expect(
      await harness.search.searchSemantic(
        [],
        harness.tenantId,
        hashingVector('pricing rate card', DIMENSIONS),
        stub.client.model,
        DIMENSIONS,
      ),
    ).toEqual([]);
  });

  it('never returns the page nobody can read, to anybody', async () => {
    for (const who of EVERYONE) {
      const hits = await hybrid.search(harness.caller(who), 'contracts legal agreement signed');
      expect(hits.map(keyOf)).not.toContain('handbook:commercial/legal/contracts');
    }
  });

  it('honours indexable: false on retrieval and nowhere else', async () => {
    const alice = harness.caller('alice');
    const query = 'troubleshooting a sync that will not finish';

    const retrieval = await hybrid.search(alice, query, { retrievalOnly: true });
    expect(retrieval.map(keyOf)).not.toContain('handbook:troubleshooting');

    const ordinary = await hybrid.search(alice, query);
    expect(ordinary.map(keyOf)).toContain('handbook:troubleshooting');

    const semantic = await harness.search.searchSemantic(
      alice.principals,
      harness.tenantId,
      hashingVector(query, DIMENSIONS),
      stub.client.model,
      DIMENSIONS,
      { retrievalOnly: true },
    );
    expect(semantic.map(keyOf)).not.toContain('handbook:troubleshooting');
  });

  it('fuses into a subset of what the two providers were each permitted to return', async () => {
    const bob = harness.caller('bob');
    const query = 'pricing rate card commercial';
    const pool = { limit: 60 };

    const lexical = await keyword.candidates(bob, query, pool);
    const semantic = await harness.search.searchSemantic(
      bob.principals,
      harness.tenantId,
      hashingVector(query, DIMENSIONS),
      stub.client.model,
      DIMENSIONS,
      pool,
    );
    const union = new Set([...lexical, ...semantic].map(keyOf));

    const fused = await hybrid.search(bob, query);
    expect(fused.length).toBeGreaterThan(0);
    for (const hit of fused) expect(union).toContain(keyOf(hit));
  });

  it('is the keyword provider outright when no endpoint is configured', async () => {
    const withoutClient = new HybridSearch(harness.search, harness.config, keyword, null);
    const query = 'pricing rate card commercial';

    expect(await withoutClient.search(harness.caller('bob'), query)).toEqual(
      await keyword.search(harness.caller('bob'), query),
    );
  });

  it('falls back to keyword results when the endpoint cannot be reached', async () => {
    const broken = stubEmbeddingClient({ dimensions: DIMENSIONS }, hashingVector);
    broken.breakWith(503);
    const degraded = new HybridSearch(harness.search, harness.config, keyword, broken.client);
    const query = 'pricing rate card commercial';

    expect((await degraded.search(harness.caller('bob'), query)).map(keyOf)).toEqual(
      (await keyword.search(harness.caller('bob'), query)).map(keyOf),
    );
  });
});

describe('asset route: 404 for unauthorized', () => {
  it('serves the chart to a commercial reader with the stored MIME', async () => {
    const res = await as('bob').get('/handbook/commercial/images/chart.jpg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('private');
  });

  it('404s the same asset for everyone else', async () => {
    for (const who of ['alice', 'carol', 'dave', 'ops', 'mallory', 'anonymous'] as const) {
      const res = await as(who).get('/handbook/commercial/images/chart.jpg');
      expect(res.status).toBe(404);
    }
  });

  it('serves the repo cover to anyone with the root grant', async () => {
    const res = await as('dave').get('/handbook/_repo/cover.jpg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });
});

describe('/-/*: 404 for non-admins', () => {
  const json = (who: PrincipalName | 'anonymous') => ({
    get: (path: string) => as(who).get(path).set('Accept', 'application/json'),
  });

  it('serves status to an admin', async () => {
    const res = await json('ops').get('/-/status');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('admin');
  });

  it('serves a maintainer-scoped status to a repo maintainer', async () => {
    const res = await json('alice').get('/-/status');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('maintainer');
    expect(res.body.repos.map((r: { slug: string }) => r.slug).sort()).toEqual([
      'handbook',
      'speicher-docs',
    ]);
  });

  it('404s for a reader who maintains nothing', async () => {
    for (const who of ['bob', 'carol', 'dave', 'mallory', 'anonymous'] as const) {
      const res = await as(who).get('/-/status');
      expect(res.status).toBe(404);
    }
  });

  it.each(['/-/dead-jobs', '/-/redirects', '/-/logs'])(
    '404s %s for everyone but an admin',
    async (path) => {
      expect([200, 301]).toContain((await as('ops').get(path)).status);
      for (const who of ['alice', 'bob', 'carol', 'dave', 'mallory', 'anonymous'] as const) {
        expect((await as(who).get(path)).status).toBe(404);
      }
    },
  );

  it('404s /-/analytics for everyone but an admin', async () => {
    expect((await as('ops').get('/-/analytics')).status).toBe(200);
    for (const who of ['alice', 'bob', 'carol', 'dave', 'mallory', 'anonymous'] as const) {
      expect((await as(who).get('/-/analytics')).status).toBe(404);
    }
  });

  it('404s /-/search for everyone but an admin, maintainers included', async () => {
    expect((await json('ops').get('/-/search?q=identity')).status).toBe(200);
    for (const who of ['alice', 'bob', 'carol', 'dave', 'mallory', 'anonymous'] as const) {
      expect((await as(who).get('/-/search?q=identity')).status).toBe(404);
    }
  });

  it('offers the dashboard in the header to an admin and to nobody else', async () => {
    expect((await as('ops').get('/')).text).toContain('href="/-/status"');
    for (const who of ['alice', 'bob', 'carol', 'dave', 'mallory', 'anonymous'] as const) {
      expect((await as(who).get('/')).text).not.toContain('/-/status');
    }
  });

  it('exempts the health probes, which have no session', async () => {
    expect((await as('anonymous').get('/-/healthz')).status).toBe(200);
    expect((await as('anonymous').get('/-/readyz')).status).toBe(200);
  });

  it('gives explain to an admin and 404s it for a stranger', async () => {
    const admin = await json('ops').get('/-/explain?path=/handbook/commercial/pricing');
    expect(admin.status).toBe(200);
    expect(admin.body.effective_principals).toEqual(['group:commercial']);
    expect(admin.body).toHaveProperty('groups');

    const stranger = await json('mallory').get('/-/explain?path=/handbook/commercial/pricing');
    expect(stranger.status).toBe(404);
  });

  it('gives a maintainer explain inside their own repo, without group sizes', async () => {
    const res = await json('alice').get('/-/explain?path=/handbook/commercial/pricing');
    expect(res.status).toBe(200);
    expect(res.body.effective_principals).toEqual(['group:commercial']);
    expect(res.body.groups).toBeUndefined();
  });

  it('404s explain for a path in a repo the maintainer does not maintain', async () => {
    const res = await json('alice').get('/-/explain?path=/northwind-engineering/specs/tolerances');
    expect(res.status).toBe(404);
  });

  it('answers a route the caller may not have exactly as it answers one that is not there', async () => {
    const denied = await as('alice').get('/-/dead-jobs');
    const absent = await as('alice').get('/-/nothing-here');
    expect(denied.status).toBe(absent.status);
    expect(denied.headers['content-type']).toBe(absent.headers['content-type']);
    const shape = (html: string) => html.replace(/nonce="[^"]*"/g, 'nonce="_"');
    expect(shape(denied.text)).toBe(shape(absent.text));
  });
});

describe('API keys never carry admin scope', () => {
  it('gives an admin holding a key their content access and nothing more', async () => {
    const key = await apiKeyFor(harness.tenantId, 'ops');
    const res = await request(app.getHttpServer())
      .get('/-/status')
      .set('Authorization', `Bearer ${key}`);
    expect(res.status).toBe(404);
  });

  it('gives a reader holding a key exactly their own content access', async () => {
    const key = await apiKeyFor(harness.tenantId, 'bob');
    const permitted = await request(app.getHttpServer())
      .get('/handbook/commercial/pricing')
      .set('Authorization', `Bearer ${key}`);
    expect(permitted.status).toBe(200);

    const denied = await request(app.getHttpServer())
      .get('/handbook/northwind/handover')
      .set('Authorization', `Bearer ${key}`);
    expect(denied.status).toBe(404);
  });

  it('does not fall back to a session cookie when the key is bad', async () => {
    const res = await request(app.getHttpServer())
      .get('/handbook/introduction')
      .set('Cookie', cookies.alice as string)
      .set('Authorization', 'Bearer spk_not-a-real-key');
    expect(res.status).toBe(404);
  });
});

describe('links to pages the reader cannot open', () => {
  it('shows the link to everyone who can read the linking page', async () => {
    for (const who of ['alice', 'bob', 'carol', 'dave'] as PrincipalName[]) {
      const res = await as(who).get('/handbook/where-things-live');
      expect(res.status).toBe(200);
      expect(res.text).toContain('/handbook/commercial/pricing');
    }
  });

  it('404s when a reader without access follows it', async () => {
    const page = await as('alice').get('/handbook/where-things-live');
    expect(page.text).toContain('/handbook/commercial/pricing');
    expect((await as('alice').get('/handbook/commercial/pricing')).status).toBe(404);
    expect((await as('bob').get('/handbook/commercial/pricing')).status).toBe(200);
  });

  it("leaks nothing about the target beyond the author's own link text", async () => {
    const res = await as('alice').get('/handbook/where-things-live');
    expect(res.text).not.toContain('Rate card');
    expect(res.text).not.toContain('Rates are indicative');
    expect(res.text).not.toContain('1,850');
  });

  it('still omits the target from the nav tree and the listing', async () => {
    const res = await as('alice').get('/handbook/');
    expect(res.text).not.toContain('Commercial');
    expect(res.text).not.toContain('Northwind');
  });

  it('404s a link to a page nobody can read, for everyone including bob', async () => {
    for (const who of EVERYONE) {
      expect((await as(who).get('/handbook/commercial/legal/contracts')).status).toBe(404);
    }
  });

  it('renders an image from a narrower folder whose bytes then 404', async () => {
    const res = await as('alice').get('/handbook/where-things-live');
    expect(res.text).toContain('/handbook/commercial/images/chart.jpg');
    expect((await as('alice').get('/handbook/commercial/images/chart.jpg')).status).toBe(404);
    expect((await as('bob').get('/handbook/commercial/images/chart.jpg')).status).toBe(200);
  });

  it('does not flag a link whose target has the same audience', async () => {
    expect((await as('alice').get('/handbook/setup')).status).toBe(200);
    expect((await as('dave').get('/handbook/setup')).status).toBe(200);
  });
});

describe('the dev-login backdoor is off unless deliberately enabled', () => {
  it('404s when SPEICHER_DEV_LOGIN is unset', async () => {
    expect(process.env.SPEICHER_DEV_LOGIN).toBeUndefined();
    const res = await as('anonymous').get('/api/auth/dev-login?subject=alice-oid&groups=grp-eng');
    expect(res.status).toBe(404);
  });

  it('grants nothing while it is off', async () => {
    const res = await as('anonymous').get('/api/auth/dev-login?subject=alice-oid&groups=grp-eng');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await as('anonymous').get('/handbook/introduction')).status).toBe(404);
  });
});

describe('icons ship only where they are visible', () => {
  const symbolsIn = (html: string) =>
    [...html.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((m) => m[1]).sort();

  it('renders the icons a reader can see', async () => {
    const res = await as('alice').get('/handbook/introduction');
    expect(symbolsIn(res.text)).toContain('sparkles');
    expect(res.text).toContain('<use href="#i-sparkles"/>');
  });

  it('never ships a symbol for a page the reader cannot see', async () => {
    const alice = await as('alice').get('/handbook/introduction');
    expect(symbolsIn(alice.text)).not.toContain('banknote');
    expect(alice.text).not.toContain('banknote');

    const bob = await as('bob').get('/handbook/introduction');
    expect(symbolsIn(bob.text)).toContain('banknote');
  });

  it('ships no symbol that the page does not reference', async () => {
    const res = await as('alice').get('/handbook/introduction');
    const used = new Set([...res.text.matchAll(/<use href="#i-([a-z0-9-]+)"/g)].map((m) => m[1]));
    for (const symbol of symbolsIn(res.text)) expect(used.has(symbol)).toBe(true);
  });

  it('emits one symbol however many times an icon is used', async () => {
    const res = await as('alice').get('/handbook/introduction');
    const symbols = symbolsIn(res.text);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it('carries only the default symbols on a page whose repository named no icon', async () => {
    const res = await as('carol').get('/northwind-engineering/specs/tolerances');
    expect(res.status).toBe(200);
    for (const symbol of symbolsIn(res.text)) {
      expect(Object.values(DEFAULT_ICONS)).toContain(symbol);
    }
  });

  it('keeps the sprite inside the CSP, with no script and no external reference', async () => {
    const res = await as('alice').get('/handbook/introduction');
    const sprite = /<svg[^>]*hidden[\s\S]*?<\/svg>/.exec(res.text)?.[0] ?? '';
    expect(sprite).not.toMatch(/<script|\son[a-z]+=|xlink:/i);
    expect(res.headers['content-security-policy']).not.toContain('unsafe-inline');
  });
});

describe('web security headers', () => {
  it('sets a CSP with no unsafe-inline, and frame-ancestors none', async () => {
    const res = await as('alice').get('/handbook/introduction');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('never emits a script tag from content', async () => {
    const res = await as('alice').get('/handbook/troubleshooting');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("alert('this must never survive ingest')");
    expect(res.text).not.toContain('javascript:alert');
  });
});
