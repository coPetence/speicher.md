import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { closeSequelize } from '../../src/db/sequelize';
import { RESERVED_FIRST_SEGMENTS, slugify } from '../../src/common/slug';
import { Harness, PrincipalName, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let app: INestApplication;
let harness: Harness;
const PUBLIC_URL = 'https://docs.example.test';

beforeAll(async () => {
  harness = await createHarness();
  process.env.SPEICHER_PUBLIC_URL = PUBLIC_URL;
  app = await bootTestApp();
});

afterAll(async () => {
  delete process.env.SPEICHER_PUBLIC_URL;
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

const get = (path: string) => request(app.getHttpServer()).get(path);

describe('the two files reach a caller with no credential', () => {
  it('serves robots.txt as plain text', async () => {
    const res = await get('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('serves sitemap.xml as XML', async () => {
    const res = await get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/xml/);
  });

  it('is not shadowed by the catch-all route', async () => {
    expect((await get('/robots.txt')).text).toContain('User-agent');
    expect((await get('/sitemap.xml')).text).toContain('<urlset');
  });

  it('cannot collide with a repository, because a slug never holds a dot', () => {
    expect(slugify('robots.txt')).toBe('robots-txt');
    expect(slugify('sitemap.xml')).toBe('sitemap-xml');
    expect(RESERVED_FIRST_SEGMENTS.has('robots.txt')).toBe(false);
  });
});

describe('robots.txt', () => {
  it('keeps crawlers off the surfaces that are not content', async () => {
    const body = (await get('/robots.txt')).text;
    for (const prefix of ['/-/', '/auth/', '/api/', '/mcp']) {
      expect(body).toContain(`Disallow: ${prefix}`);
    }
  });

  it('keeps them off the query-bearing surfaces, which are the expensive ones', async () => {
    expect((await get('/robots.txt')).text).toContain('Disallow: /*?');
  });

  it('points at the sitemap, using the declared URL and never the request Host', async () => {
    const res = await get('/robots.txt').set('Host', 'evil.example');
    expect(res.text).toContain(`Sitemap: ${PUBLIC_URL}/sitemap.xml`);
    expect(res.text).not.toContain('evil.example');
  });

  it('says why there is no sitemap when the instance has no declared URL', async () => {
    delete process.env.SPEICHER_PUBLIC_URL;
    try {
      const res = await get('/robots.txt');
      expect(res.text.split('\n').some((line) => line.startsWith('Sitemap:'))).toBe(false);
      expect(res.text).toContain('# No Sitemap');
      expect(res.text).toContain('SPEICHER_PUBLIC_URL');
      expect((await get('/sitemap.xml')).status).toBe(404);
    } finally {
      process.env.SPEICHER_PUBLIC_URL = PUBLIC_URL;
    }
  });
});

describe('the sitemap names exactly what an anonymous reader may open', () => {
  const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

  it('lists the public repository and nothing else', async () => {
    const found = locs((await get('/sitemap.xml')).text);
    expect(found).toEqual([
      `${PUBLIC_URL}/speicher-docs/`,
      `${PUBLIC_URL}/speicher-docs/getting-started`,
    ]);
  });

  it('omits the narrowed subtree of the public repository', async () => {
    expect((await get('/sitemap.xml')).text).not.toContain('internal/roadmap');
  });

  it('is the same document however it is fetched', async () => {
    const anonymous = (await get('/sitemap.xml')).text;
    for (const who of ['alice', 'ops'] as PrincipalName[]) {
      const cookie = await sessionCookieFor(harness.tenantId, who);
      const signedIn = await get('/sitemap.xml').set('Cookie', cookie);
      expect(signedIn.text).toBe(anonymous);
    }
  });

  it('may be held by a shared cache, unlike every page in the reader', async () => {
    expect((await get('/sitemap.xml')).headers['cache-control']).toBe('public, max-age=3600');
    expect((await get('/robots.txt')).headers['cache-control']).toBe('public, max-age=3600');
  });
});

describe('the robots meta tag answers the same question the sitemap does', () => {
  const hasNoindex = (html: string) => /<meta name="robots" content="noindex/.test(html);

  it('leaves a public page free to be indexed', async () => {
    const res = await get('/speicher-docs/getting-started');
    expect(res.status).toBe(200);
    expect(hasNoindex(res.text)).toBe(false);
  });

  it('marks a private page noindex even for the reader who may see it', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    const res = await get('/handbook/introduction').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(hasNoindex(res.text)).toBe(true);
  });

  it('marks a public page its author excluded from retrieval noindex', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'bob');
    const res = await get('/handbook/commercial/pricing').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(hasNoindex(res.text)).toBe(true);
  });

  it('marks a folder listing noindex, because a folder answers neither half', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    const res = await get('/handbook/reference').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(hasNoindex(res.text)).toBe(true);
  });

  it('leaves the site root indexable while the instance publishes something', async () => {
    expect(hasNoindex((await get('/')).text)).toBe(false);
  });

  it('marks search and the tag listing noindex whatever is published', async () => {
    expect(hasNoindex((await get('/?q=speicher')).text)).toBe(true);
    expect(hasNoindex((await get('/?tag=setup')).text)).toBe(true);
  });
});
