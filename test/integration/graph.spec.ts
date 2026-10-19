import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import { closeSequelize } from '../../src/db/sequelize';
import { Harness, PrincipalName, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let app: INestApplication;
let harness: Harness;
const cookies: Partial<Record<PrincipalName, string>> = {};

const MAP = '/handbook/where-things-live';
const SETUP = '/handbook/setup';
const INTRO = '/handbook/introduction';

beforeAll(async () => {
  harness = await createHarness();
  app = await bootTestApp();
  for (const name of ['alice', 'bob', 'carol', 'dave', 'ops', 'mallory'] as const) {
    cookies[name] = await sessionCookieFor(harness.tenantId, name);
  }
});

afterAll(async () => {
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

function aside(html: string): string {
  return /<aside class="spr-aside"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? '';
}

function group(html: string, heading: string): string[] {
  const section = new RegExp(
    `<h2 class="spr-aside-heading">${heading}</h2>\\s*<ul class="spr-aside-list">([\\s\\S]*?)</ul>`,
  ).exec(aside(html));
  if (!section) return [];
  return [...section[1].matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1]);
}

function chips(html: string): string[] {
  const section = /<ul class="spr-tags">([\s\S]*?)<\/ul>/.exec(aside(html));
  if (!section) return [];
  return [...section[1].matchAll(/<a class="spr-tag"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
}

function get(path: string, who: PrincipalName | 'anonymous') {
  const req = request(app.getHttpServer()).get(path);
  return who === 'anonymous' ? req : req.set('Cookie', cookies[who] as string);
}

describe('the Related column', () => {
  const SEE_ALSO: Record<'alice' | 'bob' | 'carol' | 'dave', string[]> = {
    alice: ['Setting up'],
    bob: ['Pricing', 'Commercial', 'Setting up'],
    carol: ['Handover', 'Setting up'],
    dave: ['Setting up'],
  };

  it.each(Object.entries(SEE_ALSO))(
    'shows %s only the targets they can open',
    async (who, expected) => {
      const res = await get(MAP, who as PrincipalName).expect(200);
      expect(group(res.text, 'See also')).toEqual(expected);
    },
  );

  it('never lists the page nobody can read, for anybody', async () => {
    for (const who of ['alice', 'bob', 'carol', 'dave', 'ops', 'mallory'] as const) {
      const res = await get(MAP, who);
      if (res.status === 404) continue;
      expect(aside(res.text)).not.toContain('Contracts');
    }
  });

  it('says nothing about what it withheld', async () => {
    const res = await get(MAP, 'alice').expect(200);
    const column = aside(res.text);
    expect(column).not.toMatch(/\b[1-9]\d* more\b/);
    const items = column.match(/<li>/g) ?? [];
    const links = column.match(/<li><a /g) ?? [];
    expect(items).toHaveLength(SEE_ALSO.alice.length + chips(res.text).length);
    expect(links).toHaveLength(items.length);
  });

  it('renders no column at all when there is nothing in it', async () => {
    const res = await get('/northwind-engineering/specs/tolerances', 'carol').expect(200);
    expect(aside(res.text)).toBe('');
  });
});

describe('backlinks', () => {
  it('lists the pages that point here', async () => {
    const res = await get(SETUP, 'alice').expect(200);
    expect(group(res.text, 'Referenced by')).toEqual(['Introduction', 'Where things live']);
  });

  it('filters the inbound direction by the same rule as the outbound one', async () => {
    const forBob = await get(INTRO, 'bob').expect(200);
    expect(group(forBob.text, 'Referenced by')).toContain('Pricing');

    const forAlice = await get(INTRO, 'alice').expect(200);
    expect(group(forAlice.text, 'Referenced by')).not.toContain('Pricing');
  });

  it('is reachable at the URL it advertises', async () => {
    const res = await get(MAP, 'bob').expect(200);
    const hrefs = [...aside(res.text).matchAll(/<li><a href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) await get(href, 'bob').expect(200);
  });
});

describe('tags', () => {
  it('shows each page its own spelling of a shared tag', async () => {
    expect(chips((await get(MAP, 'alice').expect(200)).text)).toEqual(['handbook', 'Navigation']);
    expect(chips((await get(SETUP, 'alice').expect(200)).text)).toEqual(['handbook', 'navigation']);
  });

  it('draws its pages as cards, each naming the repository holding it', async () => {
    const res = await get('/?tag=handbook', 'alice').expect(200);
    expect(res.text).toContain('<ul class="spr-listing spr-cards">');
    expect(res.text).toContain('<span class="spr-kind">copetence/handbook</span>');
  });

  it('lists only the pages the reader can read', async () => {
    const forAlice = await get('/?tag=handbook', 'alice').expect(200);
    expect(forAlice.text).not.toContain('Pricing');

    const forBob = await get('/?tag=handbook', 'bob').expect(200);
    expect(forBob.text).toContain('Pricing');
  });

  it('404s a tag whose every page is restricted, rather than rendering it empty', async () => {
    for (const who of ['alice', 'bob', 'carol', 'dave', 'ops', 'mallory', 'anonymous'] as const) {
      await get('/?tag=sealed', who).expect(404);
    }
  });

  it('404s a tag the reader has no member of, exactly as it 404s an unknown one', async () => {
    await get('/?tag=commercial', 'alice').expect(404);
    await get('/?tag=no-such-tag-anywhere', 'alice').expect(404);
    await get('/?tag=commercial', 'bob').expect(200);
  });

  it('is case-folded on the way in', async () => {
    await get('/?tag=NAVIGATION', 'alice').expect(200);
  });

  it('goes out uncompressed, because it echoes the reader into private content', async () => {
    const res = await get('/?tag=handbook', 'bob').set('Accept-Encoding', 'gzip').expect(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});

describe('hover previews', () => {
  function previews(html: string): Record<string, string> {
    const article =
      /<div class="spr-article">[\s\S]*?<\/div>\s*(?:<aside|<\/main)/.exec(html)?.[0] ?? '';
    const out: Record<string, string> = {};
    for (const m of article.matchAll(/<a [^>]*href="([^"]+)"[^>]*data-spr-preview="([^"]*)"/g)) {
      out[m[1]] = m[2];
    }
    return out;
  }

  it('carries the destination title and description, with no request', async () => {
    const res = await get(MAP, 'alice').expect(200);
    expect(previews(res.text)['/handbook/setup']).toBe(
      'Setting up — Getting a working environment.',
    );
  });

  it('previews only what the reader could open anyway', async () => {
    const res = await get(MAP, 'alice').expect(200);
    for (const href of Object.keys(previews(res.text))) {
      await get(href, 'alice').expect(200);
    }
  });

  it('leaves a link to a restricted page with no marker at all', async () => {
    const forAlice = await get(MAP, 'alice').expect(200);
    const forBob = await get(MAP, 'bob').expect(200);

    expect(previews(forAlice.text)['/handbook/commercial/pricing']).toBeUndefined();
    expect(previews(forBob.text)['/handbook/commercial/pricing']).toBe(
      'Rate cards and the factors that move them.',
    );

    const anchor = /<a href="\/handbook\/commercial\/pricing"[^>]*>/.exec(forAlice.text)?.[0] ?? '';
    expect(anchor).not.toBe('');
    expect(anchor).not.toContain('data-spr');
  });

  it('never previews the page nobody can read', async () => {
    for (const who of ['alice', 'bob', 'carol', 'dave', 'ops'] as const) {
      const res = await get(MAP, who);
      if (res.status !== 200) continue;
      expect(res.text).not.toMatch(/data-spr-preview="[^"]*Contracts/);
    }
  });

  it('needs no script, so the CSP has nothing new to allow', async () => {
    const res = await get(MAP, 'alice').expect(200);
    expect(res.headers['content-security-policy']).toContain("script-src 'nonce-");
    expect(res.headers['content-security-policy']).not.toContain('unsafe-inline');
  });
});

describe('the instance toggle', () => {
  let off: INestApplication;

  beforeAll(async () => {
    const loaded = loadInstanceConfigFromFile(process.env.SPEICHER_CONFIG as string);
    off = await bootTestApp(
      new ConfigService({ ...loaded, raw: { ...loaded.raw, graph: { enabled: false } } }),
    );
  });

  afterAll(async () => {
    await off?.close();
  });

  it('removes every reader-facing surface at once', async () => {
    const res = await request(off.getHttpServer())
      .get(MAP)
      .set('Cookie', cookies.bob as string)
      .expect(200);
    expect(res.text).toContain('Where things live');
    expect(aside(res.text)).toBe('');
    expect(res.text).not.toContain('data-spr-preview');
  });

  it('can switch the previews off without losing the column', async () => {
    const loaded = loadInstanceConfigFromFile(process.env.SPEICHER_CONFIG as string);
    const noPreviews = await bootTestApp(
      new ConfigService({ ...loaded, raw: { ...loaded.raw, graph: { previews: false } } }),
    );
    try {
      const res = await request(noPreviews.getHttpServer())
        .get(MAP)
        .set('Cookie', cookies.bob as string)
        .expect(200);
      expect(res.text).not.toContain('data-spr-preview');
      expect(group(res.text, 'See also')).toContain('Pricing');
    } finally {
      await noPreviews.close();
    }
  });

  it('takes the tag listing with it', async () => {
    const res = await request(off.getHttpServer())
      .get('/?tag=handbook')
      .set('Cookie', cookies.bob as string)
      .expect(200);
    expect(res.text).not.toContain('Tagged');
  });

  it('keeps recording edges, so switching it on needs no rebuild', async () => {
    const report = await harness.reports.graphReport(harness.tenantId);
    expect(report.edges).toBeGreaterThan(0);
    expect(report.terms).toBeGreaterThan(0);
  });
});

// The Link report page is disabled for now
describe.skip('the operational report', () => {
  it('is the reader 404 for everyone who is not an admin', async () => {
    for (const who of ['alice', 'bob', 'carol', 'dave', 'mallory', 'anonymous'] as const) {
      await get('/-/graph', who).expect(404);
    }
    await get('/-/graph', 'ops').expect(200);
  });

  it('serves one answer in two representations', async () => {
    const page = await get('/-/graph', 'ops').expect(200);
    const json = await get('/-/graph', 'ops').set('Accept', 'application/json').expect(200);
    expect(json.headers['content-type']).toMatch(/application\/json/);
    expect(page.text).toContain(`>${json.body.pages}<`);
    expect(page.text).toContain(`>${json.body.edges}<`);
  });

  it('reports the links that cross into a narrower grant', async () => {
    const { body } = await get('/-/graph', 'ops').set('Accept', 'application/json').expect(200);
    const targets = body.narrowing.map((e: { target_slug_path: string }) => e.target_slug_path);
    expect(targets).toContain('commercial/pricing');
    expect(targets).toContain('commercial/legal/contracts');
    const pricing = body.narrowing.find(
      (e: { target_slug_path: string }) => e.target_slug_path === 'commercial/pricing',
    );
    expect(pricing.detail).toContain('group:engineering');
  });

  it('finds no broken link in a fixture whose links all resolve', async () => {
    const { body } = await get('/-/graph', 'ops').set('Accept', 'application/json').expect(200);
    expect(body.dangling).toEqual([]);
  });
});

describe('link-weighted search', () => {
  it('reorders results without changing which rows they are', async () => {
    const loaded = loadInstanceConfigFromFile(process.env.SPEICHER_CONFIG as string);
    const unboosted = await bootTestApp(
      new ConfigService({
        ...loaded,
        raw: { ...loaded.raw, graph: { search_boost: false } },
      }),
    );
    try {
      const paths = (html: string) =>
        [...html.matchAll(/<li>\s*<span class="spr-kind">[^<]*<\/span>\s*<a href="([^"]+)"/g)]
          .map((m) => m[1])
          .sort();

      const withBoost = await get('/?q=setup', 'alice').expect(200);
      const without = await request(unboosted.getHttpServer())
        .get('/?q=setup')
        .set('Cookie', cookies.alice as string)
        .expect(200);
      expect(paths(withBoost.text)).toEqual(paths(without.text));
    } finally {
      await unboosted.close();
    }
  });
});
