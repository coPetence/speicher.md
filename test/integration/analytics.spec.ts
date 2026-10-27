import { readFileSync } from 'node:fs';

import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import request from 'supertest';

import { AnalyticsService } from '../../src/dashboard/analytics/analytics.service';
import { estimateSketch } from '../../src/dashboard/analytics/hll';
import { purgeAnalytics, sweepAnalytics } from '../../src/dashboard/analytics/retention';
import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfig } from '../../src/config/parser';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let app: INestApplication;
let harness: Harness;
let config: ConfigService;
let analytics: AnalyticsService;

function withAnalytics(block: string): void {
  const base = readFileSync(process.env.SPEICHER_CONFIG as string, 'utf8');
  config.adopt(loadInstanceConfig(`${base}\n${block}\n`));
}

const ON = ['analytics:', '  enabled: true', '  timezone: Europe/Berlin'].join('\n');

beforeAll(async () => {
  harness = await createHarness();
  app = await bootTestApp();
  config = app.get(ConfigService);
  analytics = app.get(AnalyticsService);
});

afterAll(async () => {
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

beforeEach(async () => {
  await analytics.flush();
  await getSequelize().query('DELETE FROM page_views', { type: QueryTypes.DELETE });
  await getSequelize().query('DELETE FROM search_misses', { type: QueryTypes.DELETE });
  withAnalytics(ON);
});

const get = (path: string) => request(app.getHttpServer()).get(path);

async function read(path: string, cookie?: string): Promise<number> {
  const req = get(path);
  if (cookie) req.set('Cookie', cookie);
  const res = await req;
  await analytics.flush();
  return res.status;
}

interface Row {
  slug_path: string;
  granularity: string;
  surface: string;
  views: string;
  readers: Buffer | null;
}

async function rows(): Promise<Row[]> {
  return getSequelize().query<Row>(
    `SELECT slug_path, granularity, surface, views, readers FROM page_views ORDER BY slug_path, granularity, surface`,
    { type: QueryTypes.SELECT },
  );
}

describe('a private page', () => {
  it('is counted on the server, once per read', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    expect(await read('/handbook/introduction', cookie)).toBe(200);
    expect(await read('/handbook/introduction', cookie)).toBe(200);

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ slug_path: 'introduction', surface: 'web', views: '2' });
  });

  it('records reach as a count and never as a name', async () => {
    const alice = await sessionCookieFor(harness.tenantId, 'alice');
    const bob = await sessionCookieFor(harness.tenantId, 'bob');
    await read('/handbook/introduction', alice);
    await read('/handbook/introduction', alice);
    await read('/handbook/introduction', bob);

    const [row] = await rows();
    expect(row.views).toBe('3');
    expect(estimateSketch(row.readers)).toBe(2);

    const columns = await getSequelize().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'page_views'`,
      { type: QueryTypes.SELECT },
    );
    const names = columns.map((c) => c.column_name).sort();
    expect(names).not.toContain('subject');
    expect(names).not.toContain('user_id');
    expect(names).not.toContain('identity');
    expect(names).not.toContain('email');
  });

  it('is not counted at all while the feature is off', async () => {
    withAnalytics('analytics:\n  enabled: false');
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    expect(await read('/handbook/introduction', cookie)).toBe(200);
    expect(await rows()).toHaveLength(0);
  });

  it('records no reach while unique readers are off', async () => {
    withAnalytics([ON, '  unique_readers: false'].join('\n'));
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    await read('/handbook/introduction', cookie);
    const [row] = await rows();
    expect(row.views).toBe('1');
    expect(row.readers).toBeNull();
  });
});

describe('a public page', () => {
  it('is counted in the browser, not on the server, while the beacon is on', async () => {
    const res = await get('/speicher-docs/getting-started');
    await analytics.flush();
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-spr-count');
    expect(await rows()).toHaveLength(0);
  });

  it('is counted on the server when the beacon is off, and carries no marker', async () => {
    withAnalytics([ON, '  public_beacon: false'].join('\n'));
    const res = await get('/speicher-docs/getting-started');
    await analytics.flush();
    expect(res.text).not.toContain('data-spr-count');
    expect(await rows()).toHaveLength(1);
  });

  it('is counted exactly once for a signed-in reader, never at both ends', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    const res = await get('/speicher-docs/getting-started').set('Cookie', cookie);
    await analytics.flush();
    expect(res.text).toContain('data-spr-count');
    expect(await rows()).toHaveLength(0);

    await beacon('/speicher-docs/getting-started', cookie);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].views).toBe('1');
  });
});

async function beacon(path: string, cookie?: string): Promise<number> {
  const req = request(app.getHttpServer()).post('/api/analytics/view');
  if (cookie) req.set('Cookie', cookie);
  const res = await req.send({ path });
  await analytics.flush();
  return res.status;
}

describe('the beacon', () => {
  it('counts a public page', async () => {
    expect(await beacon('/speicher-docs/getting-started')).toBe(204);
    expect(await rows()).toHaveLength(1);
  });

  it('refuses to count a private page, however the caller could read it', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    expect(await beacon('/handbook/introduction', cookie)).toBe(204);
    expect(await rows()).toHaveLength(0);
  });

  it('answers the same 204 to a path that does not exist', async () => {
    expect(await beacon('/handbook/introduction')).toBe(204);
    expect(await beacon('/nothing/here-at-all')).toBe(204);
    expect(await beacon('')).toBe(204);
    expect(await rows()).toHaveLength(0);
  });

  it('is metered and uncompressed, by being a POST and nothing else', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/analytics/view')
      .set('Accept-Encoding', 'gzip')
      .send({ path: '/speicher-docs/getting-started' });
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});

describe('an agent', () => {
  const rpc = (cookie: string, body: object) =>
    request(app.getHttpServer()).post('/mcp').set('Cookie', cookie).send(body);

  it('is counted apart from a person, which is the point of the surface column', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    await read('/handbook/introduction', cookie);
    await rpc(cookie, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read', arguments: { path: '/handbook/introduction' } },
    });
    await analytics.flush();

    const all = await rows();
    expect(all.map((r) => r.surface).sort()).toEqual(['mcp', 'web']);
    expect(all.every((r) => r.views === '1')).toBe(true);
  });

  it('is counted on a public page too, since no cache and no beacon reaches it', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    await rpc(cookie, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read', arguments: { path: '/speicher-docs/getting-started' } },
    });
    await analytics.flush();
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].surface).toBe('mcp');
  });
});

describe('searches that found nothing', () => {
  const missesOf = () =>
    getSequelize().query<{ query: string; misses: string }>(
      `SELECT query, misses FROM search_misses ORDER BY query`,
      { type: QueryTypes.SELECT },
    );

  it('records the query, and not the person who typed it', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    await read('/?q=zzzznotathing', cookie);
    const all = await missesOf();
    expect(all).toHaveLength(1);
    expect(all[0].query).toBe('zzzznotathing');

    const columns = await getSequelize().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'search_misses'`,
      { type: QueryTypes.SELECT },
    );
    expect(columns.map((c) => c.column_name).sort()).toEqual([
      'bucket',
      'misses',
      'query',
      'tenant_id',
    ]);
  });

  it('records nothing when the search found something', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    await read('/?q=introduction', cookie);
    expect(await missesOf()).toHaveLength(0);
  });
});

describe('granularity', () => {
  it('adds an hourly layer beside the daily row, rather than replacing it', async () => {
    withAnalytics([ON, '  granularity: hour'].join('\n'));
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    await read('/handbook/introduction', cookie);

    const all = await rows();
    expect(all.map((r) => r.granularity).sort()).toEqual(['day', 'hour']);
    expect(all.every((r) => r.views === '1')).toBe(true);
    expect(all.find((r) => r.granularity === 'hour')?.readers).toBeNull();
    expect(all.find((r) => r.granularity === 'day')?.readers).not.toBeNull();
  });

  it('deletes the hourly rows when it is turned back down, rather than hiding them', async () => {
    withAnalytics([ON, '  granularity: hour'].join('\n'));
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    await read('/handbook/introduction', cookie);
    expect((await rows()).some((r) => r.granularity === 'hour')).toBe(true);

    withAnalytics(ON);
    const swept = await sweepAnalytics(config);
    expect(swept.coarsened).toBeGreaterThan(0);

    const all = await rows();
    expect(all.map((r) => r.granularity)).toEqual(['day']);
    expect(all[0].views).toBe('1');
  });
});

describe('retention', () => {
  it('deletes a bucket past its window, and a query past its own shorter one', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    await read('/handbook/introduction', cookie);
    await read('/?q=zzzznotathing', cookie);

    await getSequelize().query(`UPDATE page_views SET bucket = bucket - interval '100 days'`);
    await getSequelize().query(`UPDATE search_misses SET bucket = bucket - interval '100 days'`);

    const swept = await sweepAnalytics(config);
    expect(swept.expired).toBe(1);
    expect(swept.queriesExpired).toBe(1);
    expect(await rows()).toHaveLength(0);
  });

  it('keeps a query for less time than a count, by default', async () => {
    expect(config.analytics.search_retention_days).toBeLessThan(config.analytics.retention_days);
  });

  it('deletes everything when the feature is switched off', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    await read('/handbook/introduction', cookie);
    expect(await rows()).toHaveLength(1);

    expect(await purgeAnalytics()).toBe(1);
    expect(await rows()).toHaveLength(0);
  });
});

// The Analytics page is disabled for now
describe.skip('the report', () => {
  it('is the reader’s 404 for everyone who is not an administrator', async () => {
    for (const who of ['alice', 'bob'] as const) {
      const cookie = await sessionCookieFor(harness.tenantId, who);
      expect((await get('/-/analytics').set('Cookie', cookie)).status).toBe(404);
    }
    expect((await get('/-/analytics')).status).toBe(404);
  });

  it('names the pages and counts the readers, for an administrator', async () => {
    const alice = await sessionCookieFor(harness.tenantId, 'alice');
    await read('/handbook/introduction', alice);
    await read('/handbook/introduction', alice);

    const ops = await sessionCookieFor(harness.tenantId, 'ops');
    const res = await get('/-/analytics').set('Cookie', ops).set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.totals.webViews).toBe(2);
    expect(res.body.top_pages[0]).toMatchObject({ slugPath: 'introduction', webViews: 2 });
    expect(res.body.top_pages[0].readers).toBe(1);
  });

  it('renders the page itself, not only the payload behind it', async () => {
    const alice = await sessionCookieFor(harness.tenantId, 'alice');
    await read('/handbook/introduction', alice);
    await read('/?q=zzzznotathing', alice);

    const ops = await sessionCookieFor(harness.tenantId, 'ops');
    const res = await get('/-/analytics').set('Cookie', ops);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Introduction');
    expect(res.text).toContain('zzzznotathing');
    expect(res.text).toContain('Readers');
    expect(res.text).toContain('Europe/Berlin');
    expect(res.text).toContain('class="spr-chart"');
    expect(res.text).toMatch(/<rect x="[\d.]+"/);
  });

  it('serves the chart with no script and no second request', async () => {
    const alice = await sessionCookieFor(harness.tenantId, 'alice');
    await read('/handbook/introduction', alice);

    const ops = await sessionCookieFor(harness.tenantId, 'ops');
    const res = await get('/-/analytics').set('Cookie', ops);
    const chart = /<svg class="spr-chart"[\s\S]*?<\/svg>/.exec(res.text)?.[0] ?? '';
    expect(chart).not.toBe('');
    expect(chart).not.toContain('<script');
    expect(chart).not.toContain('style=');
    expect(chart).not.toContain('<image');
  });

  it('drops the readers column rather than drawing an empty one', async () => {
    withAnalytics([ON, '  unique_readers: false'].join('\n'));
    const alice = await sessionCookieFor(harness.tenantId, 'alice');
    await read('/handbook/introduction', alice);

    const ops = await sessionCookieFor(harness.tenantId, 'ops');
    const res = await get('/-/analytics').set('Cookie', ops);
    expect(res.text).toContain('Introduction');
    expect(res.text).not.toContain('Readers');
  });

  it('states which counting regime it is in, rather than leaving it to be inferred', async () => {
    const ops = await sessionCookieFor(harness.tenantId, 'ops');

    const withBeacon = await get('/-/analytics').set('Cookie', ops);
    expect(withBeacon.text).toContain('ad blockers');

    withAnalytics([ON, '  public_beacon: false'].join('\n'));
    const without = await get('/-/analytics').set('Cookie', ops);
    expect(without.text).toContain('served by a cache');
    expect(without.text).not.toContain('ad blockers');
  });

  it('says the feature is off rather than drawing zeroes', async () => {
    withAnalytics('analytics:\n  enabled: false');
    const ops = await sessionCookieFor(harness.tenantId, 'ops');
    const res = await get('/-/analytics').set('Cookie', ops).set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.totals).toBeUndefined();
  });

  it('counts pages nobody read, against a corpus size that makes it mean something', async () => {
    const alice = await sessionCookieFor(harness.tenantId, 'alice');
    await read('/handbook/introduction', alice);

    const ops = await sessionCookieFor(harness.tenantId, 'ops');
    const res = await get('/-/analytics').set('Cookie', ops).set('Accept', 'application/json');
    expect(res.body.totals.pagesRead).toBe(1);
    expect(res.body.totals.pagesTotal).toBeGreaterThan(1);
    expect(res.body.never_read.total).toBe(res.body.totals.pagesTotal - 1);
  });
});

describe('the configuration', () => {
  it('refuses a time zone the runtime does not know, naming the key', () => {
    expect(() =>
      loadInstanceConfig('version: 1\nanalytics:\n  timezone: Europe/Berln\n'),
    ).toRefuseWith('analytics.timezone-unknown', { path: 'analytics.timezone' });
  });

  it('accepts an instance that never mentions it', () => {
    const loaded = loadInstanceConfig('version: 1\n');
    expect(loaded.raw.analytics).toBeUndefined();
  });
});
