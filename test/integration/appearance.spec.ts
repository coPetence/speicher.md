import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { closeSequelize } from '../../src/db/sequelize';
import { THEME_COOKIE } from '../../src/content-reader/views';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

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
const choose = (scheme: string, from = 'http://localhost/handbook/introduction') =>
  request(app.getHttpServer())
    .post('/api/appearance')
    .set('Referer', from)
    .type('form')
    .send({ scheme });

function sheetOf(html: string): string {
  return /href="\/-\/static\/(theme-[a-z-]+)-[0-9a-f]{12}\.css"/.exec(html)?.[1] ?? '';
}

const themeCookie = (res: { headers: Record<string, string | string[]> }): string =>
  [res.headers['set-cookie'] ?? []].flat().find((c) => c.startsWith(`${THEME_COOKIE}=`)) ?? '';

describe('the control in the account menu', () => {
  it('is a form and a set of buttons, with no script anywhere near it', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    const html = (await get('/handbook/introduction').set('Cookie', cookie)).text;

    expect(html).toContain('action="/api/appearance"');
    expect(html).not.toContain('value="/handbook/introduction"');
    for (const value of ['system', 'light', 'dark']) {
      expect(html).toContain(`value="${value}"`);
    }
  });

  it('says which of the three answers is in force', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    const before = (await get('/handbook/introduction').set('Cookie', cookie)).text;
    expect(before).toMatch(/value="system"\s+aria-pressed="true"/);
    expect(before).toMatch(/value="dark"\s+aria-pressed="false"/);

    const after = (
      await get('/handbook/introduction').set('Cookie', [cookie, `${THEME_COOKIE}=dark`])
    ).text;
    expect(after).toMatch(/value="dark"\s+aria-pressed="true"/);
    expect(after).toMatch(/value="system"\s+aria-pressed="false"/);
  });

  it('is not offered to a reader who is not signed in', async () => {
    expect((await get('/speicher-docs/getting-started')).text).not.toContain('/api/appearance');
  });
});

describe('choosing a scheme', () => {
  it('stores the answer and comes back to the page it was made on', async () => {
    const res = await choose('dark');
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe('/handbook/introduction');
    expect(themeCookie(res)).toContain(`${THEME_COOKIE}=dark`);
    expect(themeCookie(res)).toContain('HttpOnly');
    expect(themeCookie(res)).toContain('SameSite=Lax');
  });

  it('hands the question back to the browser, which is what the third button is for', async () => {
    const res = await choose('system');
    expect(res.status).toBe(303);
    expect(themeCookie(res)).toMatch(/speicher_theme=;/);
  });

  it('takes a path from the referring page and never an origin', async () => {
    expect((await choose('dark', 'https://evil.example/handbook')).headers['location']).toBe(
      '/handbook',
    );
    expect((await choose('dark', 'not a url')).headers['location']).toBe('/');
    const bare = await request(app.getHttpServer())
      .post('/api/appearance')
      .type('form')
      .send({ scheme: 'dark' });
    expect(bare.headers['location']).toBe('/');
  });
});

describe('the Secure flag', () => {
  afterEach(() => {
    delete process.env.SPEICHER_PUBLIC_URL;
    delete process.env.SPEICHER_INSECURE_COOKIES;
  });

  it('is left off over plain HTTP, so a browser on a LAN address keeps the cookie', async () => {
    expect(themeCookie(await choose('dark'))).not.toContain('Secure');
  });

  it('is set when a trusted proxy reports HTTPS', async () => {
    const res = await choose('dark').set('X-Forwarded-Proto', 'https');
    expect(themeCookie(res)).toContain('Secure');
  });

  it('is set over plain HTTP when the public URL is HTTPS', async () => {
    process.env.SPEICHER_PUBLIC_URL = 'https://docs.example.com';
    expect(themeCookie(await choose('dark'))).toContain('Secure');
  });

  it('stays off over HTTPS when SPEICHER_INSECURE_COOKIES is set', async () => {
    process.env.SPEICHER_INSECURE_COOKIES = 'true';
    const res = await choose('dark').set('X-Forwarded-Proto', 'https');
    expect(themeCookie(res)).not.toContain('Secure');
  });
});

describe('what the answer changes', () => {
  it('is which stylesheet the page links, and nothing the page draws', async () => {
    const plain = (await get('/speicher-docs/getting-started')).text;
    const dark = (await get('/speicher-docs/getting-started').set('Cookie', `${THEME_COOKIE}=dark`))
      .text;
    const light = (
      await get('/speicher-docs/getting-started').set('Cookie', `${THEME_COOKIE}=light`)
    ).text;

    expect(sheetOf(plain)).toBe('theme-default');
    expect(sheetOf(dark)).toBe('theme-dark-default');
    expect(sheetOf(light)).toBe('theme-light-default');

    expect(dark).toContain('<meta name="color-scheme" content="dark" />');
    expect(plain).toContain('<meta name="color-scheme" content="light dark" />');

    const normalise = (html: string) =>
      html
        .replace(/theme-[a-z-]*default-[0-9a-f]{12}\.css/, 'SHEET')
        .replace(/<meta name="color-scheme" content="[^"]+" \/>/, 'SCHEME')
        .replace(/nonce="[^"]+"/g, 'nonce="N"');
    expect(normalise(dark)).toBe(normalise(plain));
  });

  it('survives the operational surface', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'ops');
    const res = await get('/-/status').set('Cookie', [cookie, `${THEME_COOKIE}=dark`]);
    expect(res.status).toBe(200);
    expect(sheetOf(res.text)).toBe('theme-dark-default');
  });

  it('leaves a public page cacheable, which Vary already covered', async () => {
    const res = await get('/speicher-docs/getting-started').set('Cookie', `${THEME_COOKIE}=dark`);
    expect(res.headers['cache-control']).toBe(`public, max-age=${MAX_AGE}`);
    expect(res.headers['vary']).toContain('Cookie');
  });

  it('is ignored when it says something nobody offered', async () => {
    const res = await get('/speicher-docs/getting-started').set(
      'Cookie',
      `${THEME_COOKIE}=url(https://evil.example)`,
    );
    expect(sheetOf(res.text)).toBe('theme-default');
    expect(res.text).not.toContain('evil.example');
  });
});
