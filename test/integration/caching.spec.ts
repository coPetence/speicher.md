import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { closeSequelize } from '../../src/db/sequelize';
import { Harness, PrincipalName, createHarness } from '../helpers/harness';
import { apiKeyFor, bootTestApp, sessionCookieFor } from '../helpers/http';

let app: INestApplication;
let harness: Harness;
const MAX_AGE = 60;

beforeAll(async () => {
  harness = await createHarness();
  process.env.SPEICHER_PUBLIC_MAX_AGE = String(MAX_AGE);
  app = await bootTestApp();
});

afterAll(async () => {
  process.env.SPEICHER_PUBLIC_MAX_AGE = '0';
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

const get = (path: string) => request(app.getHttpServer()).get(path);
const cacheOf = (res: { headers: Record<string, string> }) => res.headers['cache-control'];

describe('a shared cache may keep a public page', () => {
  it('marks an anonymous read of a public page cacheable', async () => {
    const res = await get('/speicher-docs/getting-started');
    expect(res.status).toBe(200);
    expect(cacheOf(res)).toBe(`public, max-age=${MAX_AGE}`);
  });

  it('marks the site root cacheable for the same reason', async () => {
    expect(cacheOf(await get('/'))).toBe(`public, max-age=${MAX_AGE}`);
  });

  it('names both credential headers in Vary, so no cache can mix the two answers', async () => {
    const vary = (await get('/speicher-docs/getting-started')).headers['vary'];
    expect(vary).toContain('Cookie');
    expect(vary).toContain('Authorization');
  });

  it('keeps Vary on responses no cache may store either', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    const res = await get('/handbook/introduction').set('Cookie', cookie);
    expect(cacheOf(res)).toBe('private, no-store');
    expect(res.headers['vary']).toContain('Cookie');
  });

  it('lets a CDN hold an image on a public page, which is most of the point', async () => {
    const res = await get('/speicher-docs/diagram.png');
    expect(res.status).toBe(200);
    expect(cacheOf(res)).toBe(`public, max-age=${MAX_AGE}, must-revalidate`);
    expect(res.headers['vary']).toContain('Cookie');
  });

  it('keeps a restricted image out of a shared cache, on the same route', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'bob');
    const res = await get('/handbook/commercial/images/chart.jpg').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(cacheOf(res)).toBe('private, must-revalidate');
  });
});

describe('everything else stays out of a shared cache', () => {
  it('never marks a signed-in reader’s page cacheable, public content or not', async () => {
    for (const who of ['alice', 'ops', 'mallory'] as PrincipalName[]) {
      const cookie = await sessionCookieFor(harness.tenantId, who);
      const res = await get('/speicher-docs/getting-started').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(cacheOf(res)).toBe('private, no-store');
    }
  });

  it('never marks a search or a tag listing cacheable', async () => {
    expect(cacheOf(await get('/?q=speicher'))).toBe('private, no-store');
    expect(cacheOf(await get('/?tag=setup'))).toBe('private, no-store');
  });

  it('never marks a 404 cacheable', async () => {
    const res = await get('/handbook/introduction');
    expect(res.status).toBe(404);
    expect(cacheOf(res)).toBe('private, no-store');
  });

  it('never marks an admin page cacheable', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'ops');
    const res = await get('/-/status').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(cacheOf(res)).toBe('private, no-store');
  });

  it('never marks an API-key caller’s response cacheable', async () => {
    const key = await apiKeyFor(harness.tenantId, 'alice');
    const res = await get('/speicher-docs/getting-started').set('Authorization', `Bearer ${key}`);
    expect(res.status).toBe(200);
    expect(cacheOf(res)).toBe('private, no-store');
  });

  it('never marks a fragment cacheable', async () => {
    const res = await get('/speicher-docs/getting-started').set('x-speicher-fragment', '1');
    expect(res.status).toBe(200);
    expect(cacheOf(res)).toBe('private, no-store');
  });
});

describe('the switch', () => {
  it('goes back to private throughout when the max age is zero', async () => {
    process.env.SPEICHER_PUBLIC_MAX_AGE = '0';
    try {
      expect(cacheOf(await get('/speicher-docs/getting-started'))).toBe('private, no-store');
    } finally {
      process.env.SPEICHER_PUBLIC_MAX_AGE = String(MAX_AGE);
    }
  });
});
