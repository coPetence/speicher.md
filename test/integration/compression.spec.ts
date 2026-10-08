import { get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { closeSequelize } from '../../src/db/sequelize';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let app: INestApplication;
let harness: Harness;
let alice: string;
let port: number;

beforeAll(async () => {
  harness = await createHarness();
  app = await bootTestApp();
  alice = await sessionCookieFor(harness.tenantId, 'alice');
  port = (app.getHttpServer().address() as AddressInfo).port;
});

function wire(
  path: string,
  encoding: string,
): Promise<{ bytes: Buffer; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    httpGet(
      { host: '127.0.0.1', port, path, headers: { cookie: alice, 'accept-encoding': encoding } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ bytes: Buffer.concat(chunks), headers: res.headers }));
      },
    ).on('error', reject);
  });
}

afterAll(async () => {
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

const get = (path: string, encoding = 'gzip') =>
  request(app.getHttpServer()).get(path).set('Cookie', alice).set('Accept-Encoding', encoding);

describe('compression', () => {
  it('compresses a documentation page', async () => {
    const res = await get('/fieldkit/device-management');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('is a large win on a page carrying a big nav tree', async () => {
    const compressed = await wire('/fieldkit/device-management', 'gzip');
    const plain = await wire('/fieldkit/device-management', 'identity');

    expect(compressed.headers['content-encoding']).toBe('gzip');
    expect(plain.bytes.length).toBeGreaterThan(20_000);
    expect(compressed.bytes.length).toBeLessThan(plain.bytes.length / 4);
    const withoutNonces = (html: string) => html.replace(/nonce="[^"]*"/g, 'nonce="_"');
    expect(withoutNonces(gunzipSync(compressed.bytes).toString('utf8'))).toBe(
      withoutNonces(plain.bytes.toString('utf8')),
    );
  });

  it('advertises Vary so a shared cache cannot serve the wrong encoding', async () => {
    const res = await get('/fieldkit/device-management');
    expect(String(res.headers['vary'])).toMatch(/accept-encoding/i);
  });

  it('leaves the body identical when the client does not accept an encoding', async () => {
    const res = await get('/handbook/introduction', 'identity');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.text).toContain('Introduction');
  });

  it('honours the conventional x-no-compression opt-out', async () => {
    const res = await request(app.getHttpServer())
      .get('/fieldkit/device-management')
      .set('Cookie', alice)
      .set('Accept-Encoding', 'gzip')
      .set('x-no-compression', '1');
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});

describe('responses that reflect the caller query are not compressed', () => {
  it('does not compress search results', async () => {
    const res = await get('/?q=architecture');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('compresses the same page without a query', async () => {
    const res = await get('/');
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('does not compress any page carrying a query, not only the search route', async () => {
    const res = await get('/handbook/introduction?q=commercial');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('does not compress the explain page, which is the same shape under another name', async () => {
    const res = await request(app.getHttpServer())
      .get('/-/explain?path=/handbook/commercial/pricing')
      .set('Cookie', alice)
      .set('Accept-Encoding', 'gzip');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('does not compress a response to a request that carried a body', async () => {
    const ops = await sessionCookieFor(harness.tenantId, 'ops');
    const res = await request(app.getHttpServer())
      .post('/-/config/reading')
      .set('Cookie', ops)
      .set('Accept-Encoding', 'gzip')
      .send({ yaml: 'nonsense: [', intent: 'check' });
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('still compresses the admin pages that carry no query', async () => {
    const res = await get('/-/status');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('still filters search results by principal', async () => {
    const res = await get('/?q=pricing');
    expect(res.text).not.toContain('/handbook/commercial/pricing');
  });
});

describe('assets', () => {
  it('does not waste effort compressing bytes that are already compressed', async () => {
    const res = await request(app.getHttpServer())
      .get('/handbook/_repo/cover.jpg')
      .set('Cookie', alice)
      .set('Accept-Encoding', 'gzip');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
