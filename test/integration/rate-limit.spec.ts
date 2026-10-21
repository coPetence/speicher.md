import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { reflectsCallerInput } from '../../src/app-setup';
import { closeSequelize } from '../../src/db/sequelize';
import { Harness, createHarness } from '../helpers/harness';
import { accessTokenFor, bootTestApp, sessionCookieFor } from '../helpers/http';

let app: INestApplication;
let harness: Harness;

const LIMIT = 3;

beforeAll(async () => {
  harness = await createHarness();
  process.env.SPEICHER_ANON_RATE_LIMIT = String(LIMIT);
  app = await bootTestApp();
});

afterAll(async () => {
  process.env.SPEICHER_ANON_RATE_LIMIT = '0';
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

let nextAddress = 0;
function fromNewAddress() {
  const ip = `203.0.113.${(nextAddress += 1)}`;
  return {
    get: (path: string) => request(app.getHttpServer()).get(path).set('X-Forwarded-For', ip),
    post: (path: string) => request(app.getHttpServer()).post(path).set('X-Forwarded-For', ip),
  };
}

describe('what is counted', () => {
  it('meters an anonymous search past the limit', async () => {
    const client = fromNewAddress();
    for (let i = 0; i < LIMIT; i += 1) {
      expect((await client.get(`/?q=speicher${i}`)).status).toBe(200);
    }
    const refused = await client.get('/?q=speicher');
    expect(refused.status).toBe(429);
  });

  it('does not meter ordinary page reads', async () => {
    const client = fromNewAddress();
    for (let i = 0; i < LIMIT * 4; i += 1) {
      expect((await client.get('/speicher-docs/getting-started')).status).toBe(200);
    }
  });

  it('meters the tag listing, which is the other query-bearing reader surface', async () => {
    const client = fromNewAddress();
    for (let i = 0; i < LIMIT; i += 1) await client.get(`/?tag=setup${i}`);
    expect((await client.get('/?tag=setup')).status).toBe(429);
  });

  it('meters MCP, where an anonymous caller can ask for a search directly', async () => {
    const client = fromNewAddress();
    const call = () =>
      client.post('/mcp').send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search', arguments: { query: 'speicher' } },
      });
    for (let i = 0; i < LIMIT; i += 1) expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });

  it('counts one budget across surfaces, not one per route', async () => {
    const client = fromNewAddress();
    await client.get('/?q=one');
    await client.get('/?tag=two');
    await client.post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((await client.get('/?q=four')).status).toBe(429);
  });

  it('keeps one address away from another', async () => {
    const noisy = fromNewAddress();
    for (let i = 0; i < LIMIT + 1; i += 1) await noisy.get(`/?q=x${i}`);
    expect((await noisy.get('/?q=again')).status).toBe(429);
    expect((await fromNewAddress().get('/?q=again')).status).toBe(200);
  });
});

describe('who is counted', () => {
  it('does not meter a signed-in reader', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    const client = fromNewAddress();
    for (let i = 0; i < LIMIT * 3; i += 1) {
      const res = await client.get(`/?q=speicher${i}`).set('Cookie', cookie);
      expect(res.status).toBe(200);
    }
  });

  it('does not meter an OAuth access token', async () => {
    const token = await accessTokenFor(harness.tenantId, 'alice');
    const client = fromNewAddress();
    for (let i = 0; i < LIMIT * 3; i += 1) {
      const res = await client
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(res.status).toBe(200);
    }
  });

  it('meters a caller whose credential resolved to nobody', async () => {
    const client = fromNewAddress();
    for (let i = 0; i < LIMIT; i += 1) {
      await client.get(`/?q=x${i}`).set('Cookie', 'speicher_session=not-a-real-session');
    }
    const refused = await client.get('/?q=x').set('Cookie', 'speicher_session=not-a-real-session');
    expect(refused.status).toBe(429);
  });
});

describe('the refusal itself', () => {
  it('says when to come back, and is never cached', async () => {
    const client = fromNewAddress();
    for (let i = 0; i < LIMIT; i += 1) await client.get(`/?q=x${i}`);
    const res = await client.get('/?q=x');
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('is plain text rather than the reader shell', async () => {
    const client = fromNewAddress();
    for (let i = 0; i < LIMIT; i += 1) await client.get(`/?q=x${i}`);
    const res = await client.get('/?q=x');
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).not.toContain('<html');
  });
});

describe('the predicate is shared with compression', () => {
  it('is one function, so a new query-bearing surface is covered by both', () => {
    const req = (over: Partial<{ query: object; method: string }>) =>
      ({ query: {}, method: 'GET', headers: {}, ...over }) as never;
    expect(reflectsCallerInput(req({}))).toBe(false);
    expect(reflectsCallerInput(req({ query: { q: 'x' } }))).toBe(true);
    expect(reflectsCallerInput(req({ method: 'POST' }))).toBe(true);
    expect(reflectsCallerInput(req({ method: 'HEAD' }))).toBe(false);
  });
});
