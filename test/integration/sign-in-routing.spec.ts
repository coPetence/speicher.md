import { Server, createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfig } from '../../src/config/parser';
import { LoginFlow, MagicLinkToken } from '../../src/db/models';
import { closeSequelize } from '../../src/db/sequelize';
import { Mailer } from '../../src/notify/mailer';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let harness: Harness;
let idp: { base: string; stop: () => Promise<void> };
const sent: { to: string; text: string }[] = [];
const mailer = {
  send: async (to: string, _subject: string, text: string) => {
    sent.push({ to, text });
  },
};

beforeAll(async () => {
  harness = await createHarness();
  idp = await startFakeIdp();
});

beforeEach(() => {
  sent.length = 0;
});

afterAll(async () => {
  await idp?.stop();
  await harness?.close();
  await closeSequelize();
});

/**
 * Two OIDC providers for copetence.test, one for partner.test, and GitHub and a magic
 * link for every other address
 */
function instanceYaml(magicLink = true): string {
  const letter = [
    '    letter:',
    '      type: magic-link',
    'admins:',
    '  users:',
    '    - provider: letter',
    '      email: guest@elsewhere.test',
    '      note: the address a magic link is sent to',
  ];
  const admin = [
    'admins:',
    '  users:',
    '    - provider: hub',
    '      subject: the-administrator',
    '      note: nobody signs in as the admin here',
  ];
  return [
    'version: 1',
    'mail:',
    '  host: localhost',
    '  from: docs@example.test',
    'auth:',
    '  providers:',
    '    entra:',
    '      type: oidc',
    `      issuer: ${idp.base}/entra`,
    '      client_id: entra-client',
    '      domains: [copetence.test]',
    '    second:',
    '      type: oidc',
    `      issuer: ${idp.base}/second`,
    '      client_id: second-client',
    '      domains: [copetence.test]',
    '    partner:',
    '      type: oidc',
    `      issuer: ${idp.base}/partner`,
    '      client_id: partner-client',
    '      domains: [Partner.test]',
    '    hub:',
    '      type: github',
    '      client_id: hub-client',
    '      client_secret: a-secret',
    // Another origin than the OIDC providers, so the page has to name both
    `      base_url: ${githubBase()}`,
    ...(magicLink ? letter : admin),
  ].join('\n');
}

describe('the sign-in page', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootTestApp(
      new ConfigService(loadInstanceConfig(instanceYaml())),
      [],
      [{ token: Mailer, value: mailer }],
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const discover = (fields: Record<string, string>) =>
    http().post('/api/auth/discover').type('form').send(fields);

  it('asks for an address, and offers the providers for every address below it', async () => {
    const page = await http().get('/api/auth/login?redirect_to=/handbook').expect(200);

    expect(page.text).toContain('<h1>Sign in with Email</h1>');
    expect(page.text).toContain('placeholder="Enter your email address"');
    expect(page.text).toContain('action="/api/auth/discover"');
    expect(page.text).toContain('value="/handbook"');
    expect(page.text).toContain('Sign in with hub');
    expect(page.text).not.toContain('Sign in with entra');
    expect(page.text).not.toContain('Sign in with partner');
    // The magic link is what the address field does, not a button of its own
    expect(page.text).not.toContain('Sign in with letter');
  });

  it('lets its forms be redirected to every provider a sign-in starts at', async () => {
    const page = await http().get('/api/auth/login').expect(200);

    const formAction = formActionOf(page.headers['content-security-policy']);
    expect(formAction).toEqual(["'self'", idp.base, githubBase()]);
  });

  it('sends an address at a routed domain straight to its provider, with a login hint', async () => {
    const response = await discover({ email: 'Ada@partner.test', redirect_to: '/handbook' });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.origin + location.pathname).toBe(`${idp.base}/partner/authorize`);
    expect(location.searchParams.get('login_hint')).toBe('Ada@partner.test');
    const state = location.searchParams.get('state') ?? '';
    expect((await LoginFlow.findOne({ where: { state } }))?.redirect_to).toBe('/handbook');
  });

  it('offers the choice when several providers name the domain, posting the address again', async () => {
    const page = await discover({ email: 'ada@copetence.test', redirect_to: '/handbook' });

    expect(page.status).toBe(200);
    expect(page.text).toContain('Sign in with entra');
    expect(page.text).toContain('Sign in with second');
    expect(page.text).not.toContain('Sign in with hub');
    expect(page.text).toContain('name="provider" value="second"');
    expect(page.text).toContain('value="ada@copetence.test"');
    expect(page.text).not.toContain('login_hint');
    expect(formActionOf(page.headers['content-security-policy'])).toContain(idp.base);
  });

  it('starts the chosen provider', async () => {
    const response = await discover({
      email: 'ada@copetence.test',
      provider: 'second',
      redirect_to: '/',
    });

    expect(response.status).toBe(302);
    expect(new URL(response.headers.location as string).pathname).toBe('/second/authorize');
  });

  it('refuses a provider that is not offered for the address', async () => {
    const page = await discover({ email: 'ada@copetence.test', provider: 'letter' });

    expect(page.status).toBe(200);
    expect(page.text).toContain('Sign in with entra');
    expect(sent).toEqual([]);
  });

  it('answers an address without an account exactly like one with', async () => {
    const known = await discover({ email: 'guest@elsewhere.test' });
    const unknown = await discover({ email: 'nobody@elsewhere.test' });

    expect(sent.map((mail) => mail.to)).toEqual(['guest@elsewhere.test']);
    // Every page carries its own CSP nonce
    const page = (res: { text: string }, email: string) =>
      res.text.replaceAll(email, '').replace(/nonce="[^"]*"/g, '');
    expect(page(unknown, 'nobody@elsewhere.test')).toBe(page(known, 'guest@elsewhere.test'));
  });

  it('sends a magic link for any other address, and opens the page it was asked from', async () => {
    const asked = await discover({ email: 'guest@elsewhere.test', redirect_to: '/handbook' });

    expect(asked.status).toBe(200);
    expect(asked.text).toContain('<h1>Check your email</h1>');
    expect(asked.text).toContain('<span class="spr-signin-address">guest@elsewhere.test</span>');
    expect(sent.map((mail) => mail.to)).toEqual(['guest@elsewhere.test']);

    const token = /token=([^\s]+)/.exec(sent[0].text)?.[1] ?? '';
    const binding = (asked.headers['set-cookie'] as unknown as string[])
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
    const redeemed = await http()
      .get(`/api/auth/magic/callback?token=${token}`)
      .set('Cookie', binding)
      .expect(302);
    expect(redeemed.headers.location).toBe('/handbook');
  });

  it('keeps a magic link asked from elsewhere from opening another site', async () => {
    await discover({ email: 'guest@elsewhere.test', redirect_to: '//evil.test/' });

    const row = await MagicLinkToken.findOne({
      where: { email: 'guest@elsewhere.test' },
      order: [['created_at', 'DESC']],
    });
    expect(row?.redirect_to).toBe('/');
  });

  it('points an address no provider names to the buttons', async () => {
    const without = await bootTestApp(new ConfigService(loadInstanceConfig(instanceYaml(false))));
    try {
      const page = await request(without.getHttpServer())
        .post('/api/auth/discover')
        .type('form')
        .send({ email: 'zoe@elsewhere.test' })
        .expect(200);
      expect(page.text).toContain('No sign-in is set up for this address.');
      expect(page.text).toContain('Sign in with hub');
    } finally {
      await without.close();
    }
  });

  it('asks again for an address without a domain', async () => {
    const page = await discover({ email: 'ada' });

    expect(page.status).toBe(200);
    expect(page.text).toContain('Enter your full email address.');
  });
});

describe('an address no provider is offered for', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const yaml = [
      'version: 1',
      'auth:',
      '  providers:',
      '    entra:',
      '      type: oidc',
      `      issuer: ${idp.base}/entra`,
      '      client_id: entra-client',
      '      domains: [copetence.test]',
      '    partner:',
      '      type: oidc',
      `      issuer: ${idp.base}/partner`,
      '      client_id: partner-client',
      '      domains: [partner.test]',
      'admins:',
      '  users:',
      '    - provider: entra',
      '      subject: the-administrator',
      '      note: nobody signs in as the admin here',
    ].join('\n');
    app = await bootTestApp(new ConfigService(loadInstanceConfig(yaml)));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('is told so, and offered no buttons', async () => {
    const start = await request(app.getHttpServer()).get('/api/auth/login').expect(200);
    expect(start.text).not.toContain('spr-signin-option');
    expect(start.text).toContain('<h1>Sign in with Email</h1>');

    const page = await request(app.getHttpServer())
      .post('/api/auth/discover')
      .type('form')
      .send({ email: 'zoe@elsewhere.test' })
      .expect(200);
    expect(page.text).toContain('There is no way to sign in with this address.');
    expect(page.text).toContain('value="zoe@elsewhere.test"');
  });
});

describe('a signed-out browser on a page it cannot open', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootTestApp(new ConfigService(loadInstanceConfig(instanceYaml())));
  });

  afterAll(async () => {
    await app?.close();
  });

  const HTML = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';

  it('is sent to sign in, coming back to the page afterwards', async () => {
    const response = await request(app.getHttpServer())
      .get('/no-such-repo/page?tab=2')
      .set('Accept', HTML)
      .expect(302);

    expect(response.headers.location).toBe(
      `/api/auth/login?redirect_to=${encodeURIComponent('/no-such-repo/page?tab=2')}`,
    );
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('is sent to sign in from an admin page too', async () => {
    const response = await request(app.getHttpServer())
      .get('/-/config')
      .set('Accept', HTML)
      .expect(302);
    expect(response.headers.location).toMatch(/^\/api\/auth\/login\?redirect_to=/);
  });

  it('keeps the 404 for a request that does not ask for a page', async () => {
    await request(app.getHttpServer()).get('/no-such-repo/page').expect(404);
    await request(app.getHttpServer())
      .get('/no-such-repo/page')
      .set('Accept', 'application/json')
      .expect(404);
    await request(app.getHttpServer())
      .get('/no-such-repo/page')
      .set('Accept', HTML)
      .set('X-Speicher-Fragment', '1')
      .expect(404);
  });

  it('keeps the 404 for someone signed in', async () => {
    const cookie = await sessionCookieFor(harness.tenantId, 'alice');
    await request(app.getHttpServer())
      .get('/no-such-repo/page')
      .set('Accept', HTML)
      .set('Cookie', cookie)
      .expect(404);
  });
});

/** The fake IdP under another origin, standing in for a GitHub Enterprise host */
function githubBase(): string {
  return idp.base.replace('127.0.0.1', 'localhost');
}

/** The sources of a Content-Security-Policy's `form-action` */
function formActionOf(policy: string | undefined): string[] {
  const directive = (policy ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('form-action '));
  return directive ? directive.split(/\s+/).slice(1) : [];
}

/** Serves the discovery document of any issuer under it, e.g. `/entra` */
async function startFakeIdp(): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const match = /^\/([a-z]+)\/\.well-known\/openid-configuration$/.exec(req.url ?? '');
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const issuer = `${base}/${match[1]}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
