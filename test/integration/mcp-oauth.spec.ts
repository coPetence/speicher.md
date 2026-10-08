import type { INestApplication } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';

import { CIMD_DEPS } from '../../src/auth/oauth/cimd';
import { escapeHtml } from '../../src/content-reader/views';
import { closeSequelize } from '../../src/db/sequelize';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let app: INestApplication;
let harness: Harness;
let clientServer: Server;
let clientBase: string;
let aliceCookie: string;

const DECLARED_URL = 'https://docs.example.com';
const beforeUrl = process.env.SPEICHER_PUBLIC_URL;

let clientDocument: Record<string, unknown>;

const HOSTED_REDIRECT = 'https://claude.example/api/mcp/auth_callback';

beforeAll(async () => {
  process.env.SPEICHER_PUBLIC_URL = DECLARED_URL;

  clientServer = createServer((req, res) => {
    if (req.url === '/client-metadata.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(clientDocument));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => clientServer.listen(0, '127.0.0.1', resolve));
  clientBase = `http://127.0.0.1:${(clientServer.address() as AddressInfo).port}`;

  harness = await createHarness();
  app = await bootTestApp(
    undefined,
    [],
    [{ token: CIMD_DEPS, value: { allowInsecureClientId: true } }],
  );
  aliceCookie = await sessionCookieFor(harness.tenantId, 'alice');
});

beforeEach(() => {
  clientDocument = {
    client_id: `${clientBase}/client-metadata.json`,
    client_name: 'Test Agent',
    redirect_uris: [HOSTED_REDIRECT, 'http://localhost/callback', 'http://127.0.0.1/callback'],
  };
});

afterAll(async () => {
  if (beforeUrl === undefined) delete process.env.SPEICHER_PUBLIC_URL;
  else process.env.SPEICHER_PUBLIC_URL = beforeUrl;
  await new Promise<void>((resolve) => clientServer.close(() => resolve()));
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

function clientId(): string {
  return `${clientBase}/client-metadata.json`;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeParams(challenge: string, redirectUri = HOSTED_REDIRECT) {
  return {
    response_type: 'code',
    client_id: clientId(),
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'opaque-state',
    resource: `${DECLARED_URL}/mcp`,
  };
}

async function consent(
  params: Record<string, string>,
  cookie: string = aliceCookie,
): Promise<request.Response> {
  return request(app.getHttpServer())
    .post('/api/auth/oauth/consent')
    .set('Cookie', cookie)
    .type('form')
    .send(params);
}

async function connect(): Promise<{ accessToken: string; refreshToken: string }> {
  const { verifier, challenge } = pkce();
  const params = authorizeParams(challenge);

  const granted = await consent(params);
  expect(granted.status).toBe(302);
  const code = new URL(granted.headers.location).searchParams.get('code');
  expect(code).toBeTruthy();

  const token = await request(app.getHttpServer()).post('/api/auth/oauth/token').type('form').send({
    grant_type: 'authorization_code',
    code: code!,
    client_id: clientId(),
    redirect_uri: HOSTED_REDIRECT,
    code_verifier: verifier,
  });
  expect(token.status).toBe(200);
  return { accessToken: token.body.access_token, refreshToken: token.body.refresh_token };
}

describe('discovery', () => {
  it('publishes protected resource metadata at both paths a client probes', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status).toBe(200);
      expect(res.body.resource).toBe(`${DECLARED_URL}/mcp`);
      expect(res.body.authorization_servers).toEqual([DECLARED_URL]);
    }
  });

  it('advertises both halves of CIMD support', async () => {
    const res = await request(app.getHttpServer()).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.client_id_metadata_document_supported).toBe(true);
    expect(res.body.token_endpoint_auth_methods_supported).toContain('none');
    expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(res.body.issuer).toBe(DECLARED_URL);
  });

  it('serves nothing at all when no public URL is declared', async () => {
    delete process.env.SPEICHER_PUBLIC_URL;
    try {
      const res = await request(app.getHttpServer()).get('/.well-known/oauth-authorization-server');
      expect(res.status).toBe(404);
    } finally {
      process.env.SPEICHER_PUBLIC_URL = DECLARED_URL;
    }
  });
});

describe('the authorization request', () => {
  it('sends an unauthenticated caller to sign in, and comes back with every parameter', async () => {
    const { challenge } = pkce();
    const res = await request(app.getHttpServer())
      .get('/api/auth/oauth/authorize')
      .query(authorizeParams(challenge));
    expect(res.status).toBe(302);
    const back = new URL(res.headers.location, DECLARED_URL);
    expect(back.pathname).toBe('/api/auth/login');
    const resume = new URLSearchParams(back.searchParams.get('redirect_to')!.split('?')[1]);
    expect(resume.get('code_challenge')).toBe(challenge);
    expect(resume.get('state')).toBe('opaque-state');
  });

  it('shows a signed-in reader a consent screen naming the client and where it lands', async () => {
    const { challenge } = pkce();
    const res = await request(app.getHttpServer())
      .get('/api/auth/oauth/authorize')
      .set('Cookie', aliceCookie)
      .query(authorizeParams(challenge));
    expect(res.status).toBe(200);
    expect(res.text).toContain('Test Agent');
    expect(res.text).toContain('claude.example');
  });

  // The consent page is the only thing carrying the authorization request across the
  // post, so a parameter its form drops is a flow that fails at the exchange with a
  // valid-looking consent behind it. Asserted on the form, not on a post this test
  // built itself
  it('carries every authorization parameter through the consent form', async () => {
    const { challenge } = pkce();
    const params = authorizeParams(challenge);
    const res = await request(app.getHttpServer())
      .get('/api/auth/oauth/authorize')
      .set('Cookie', aliceCookie)
      .query(params);

    for (const [name, value] of Object.entries(params)) {
      expect(res.text).toContain(`name="${name}" value="${escapeHtml(value)}"`);
    }
  });

  it('refuses a redirect_uri the client has not published', async () => {
    const { challenge } = pkce();
    const res = await request(app.getHttpServer())
      .get('/api/auth/oauth/authorize')
      .set('Cookie', aliceCookie)
      .query(authorizeParams(challenge, 'https://attacker.example/collect'));
    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });

  it.each([['http://localhost:53127/callback'], ['http://127.0.0.1:61999/callback']])(
    'accepts the loopback redirect %s, ignoring the port',
    async (redirectUri) => {
      const { challenge } = pkce();
      const res = await request(app.getHttpServer())
        .get('/api/auth/oauth/authorize')
        .set('Cookie', aliceCookie)
        .query(authorizeParams(challenge, redirectUri));
      expect(res.status).toBe(200);
    },
  );

  it('refuses a loopback redirect whose path the client did not publish', async () => {
    const { challenge } = pkce();
    const res = await request(app.getHttpServer())
      .get('/api/auth/oauth/authorize')
      .set('Cookie', aliceCookie)
      .query(authorizeParams(challenge, 'http://localhost:53127/steal'));
    expect(res.status).toBe(400);
  });

  it('refuses anything but S256', async () => {
    const { verifier } = pkce();
    const res = await request(app.getHttpServer())
      .get('/api/auth/oauth/authorize')
      .set('Cookie', aliceCookie)
      .query({ ...authorizeParams(verifier), code_challenge_method: 'plain' });
    expect(res.status).toBe(400);
  });

  it('refuses a token request for somebody else’s server', async () => {
    const { challenge } = pkce();
    const res = await request(app.getHttpServer())
      .get('/api/auth/oauth/authorize')
      .set('Cookie', aliceCookie)
      .query({ ...authorizeParams(challenge), resource: 'https://other.example/mcp' });
    expect(res.status).toBe(400);
  });

  it('refuses a client whose metadata document cannot be read', async () => {
    const { challenge } = pkce();
    const res = await request(app.getHttpServer())
      .get('/api/auth/oauth/authorize')
      .set('Cookie', aliceCookie)
      .query({ ...authorizeParams(challenge), client_id: `${clientBase}/nothing-here.json` });
    expect(res.status).toBe(400);
  });

  it('refuses a document that names a different client_id than it was fetched from', async () => {
    clientDocument = { ...clientDocument, client_id: 'https://someone-else.example/meta.json' };
    const { challenge } = pkce();
    const res = await request(app.getHttpServer())
      .get('/api/auth/oauth/authorize')
      .set('Cookie', aliceCookie)
      .query(authorizeParams(challenge));
    expect(res.status).toBe(400);
  });
});

describe('the token endpoint', () => {
  it('exchanges a code for a token that reads as its owner', async () => {
    const { accessToken } = await connect();

    const mine = await request(app.getHttpServer())
      .post('/mcp')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read', arguments: { path: '/handbook/introduction' } },
      });
    expect(mine.status).toBe(200);
    expect(mine.body.result.content[0].text).toContain('#');
  });

  it('reaches exactly what its owner reaches, and no further', async () => {
    const { accessToken } = await connect();
    const forbidden = await request(app.getHttpServer())
      .post('/mcp')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read', arguments: { path: '/handbook/commercial/pricing' } },
      });
    expect(forbidden.body.result.content[0].text).toContain('No document at');
  });

  it('never administers, whoever granted it', async () => {
    const opsCookie = await sessionCookieFor(harness.tenantId, 'ops');
    const { verifier, challenge } = pkce();
    const params = authorizeParams(challenge);
    const granted = await consent(params, opsCookie);
    const code = new URL(granted.headers.location).searchParams.get('code')!;
    const token = await request(app.getHttpServer())
      .post('/api/auth/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        client_id: clientId(),
        redirect_uri: HOSTED_REDIRECT,
        code_verifier: verifier,
      });

    const admin = await request(app.getHttpServer())
      .get('/-/status')
      .set('Authorization', `Bearer ${token.body.access_token}`);
    expect(admin.status).toBe(404);
  });

  it('refuses a code whose verifier does not match the challenge', async () => {
    const { challenge } = pkce();
    const granted = await consent(authorizeParams(challenge));
    const code = new URL(granted.headers.location).searchParams.get('code')!;

    const res = await request(app.getHttpServer()).post('/api/auth/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      client_id: clientId(),
      redirect_uri: HOSTED_REDIRECT,
      code_verifier: 'not-the-verifier',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('spends a code exactly once', async () => {
    const { verifier, challenge } = pkce();
    const granted = await consent(authorizeParams(challenge));
    const code = new URL(granted.headers.location).searchParams.get('code')!;
    const body = {
      grant_type: 'authorization_code',
      code,
      client_id: clientId(),
      redirect_uri: HOSTED_REDIRECT,
      code_verifier: verifier,
    };

    expect(
      (await request(app.getHttpServer()).post('/api/auth/oauth/token').type('form').send(body))
        .status,
    ).toBe(200);
    const again = await request(app.getHttpServer())
      .post('/api/auth/oauth/token')
      .type('form')
      .send(body);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
  });

  it('refuses a code presented with a different redirect_uri', async () => {
    const { verifier, challenge } = pkce();
    const granted = await consent(authorizeParams(challenge));
    const code = new URL(granted.headers.location).searchParams.get('code')!;

    const res = await request(app.getHttpServer()).post('/api/auth/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      client_id: clientId(),
      redirect_uri: 'http://localhost:1/callback',
      code_verifier: verifier,
    });
    expect(res.body.error).toBe('invalid_grant');
  });
});

describe('refresh', () => {
  it('rotates the refresh token and refuses the one it replaced', async () => {
    const { refreshToken } = await connect();

    const first = await request(app.getHttpServer())
      .post('/api/auth/oauth/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId() });
    expect(first.status).toBe(200);
    expect(first.body.refresh_token).not.toBe(refreshToken);

    const replayed = await request(app.getHttpServer())
      .post('/api/auth/oauth/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId() });
    expect(replayed.status).toBe(400);
    expect(replayed.body.error).toBe('invalid_grant');
  });

  it('refuses a refresh token presented by another client', async () => {
    const { refreshToken } = await connect();
    const res = await request(app.getHttpServer()).post('/api/auth/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'https://someone-else.example/meta.json',
    });
    expect(res.body.error).toBe('invalid_grant');
  });
});

describe('connections', () => {
  it('lists the connection and stops it working when disconnected', async () => {
    const { accessToken } = await connect();

    const page = await request(app.getHttpServer())
      .get('/-/connections')
      .set('Cookie', aliceCookie)
      .set('Accept', 'application/json');
    expect(page.status).toBe(200);
    const connection = (page.body.connections as { id: string; client_name: string }[]).find(
      (row) => row.client_name === 'Test Agent',
    );
    expect(connection).toBeDefined();

    await request(app.getHttpServer())
      .post('/-/connections/revoke')
      .set('Cookie', aliceCookie)
      .type('form')
      .send({ id: connection!.id });

    const after = await request(app.getHttpServer())
      .post('/mcp')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list', arguments: {} },
      });
    expect(after.body.result.content[0].text).not.toContain('handbook');
  });

  it('will not let one reader revoke another’s connection', async () => {
    const { accessToken } = await connect();
    const page = await request(app.getHttpServer())
      .get('/-/connections')
      .set('Cookie', aliceCookie)
      .set('Accept', 'application/json');
    const mine = (page.body.connections as { id: string }[])[0];

    const bobCookie = await sessionCookieFor(harness.tenantId, 'bob');
    await request(app.getHttpServer())
      .post('/-/connections/revoke')
      .set('Cookie', bobCookie)
      .type('form')
      .send({ id: mine.id });

    const still = await request(app.getHttpServer())
      .post('/mcp')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read', arguments: { path: '/handbook/introduction' } },
      });
    expect(still.body.result.content[0].text).toContain('#');
  });

  it('is the reader’s own page, so an anonymous caller gets the reader’s 404', async () => {
    const res = await request(app.getHttpServer()).get('/-/connections');
    expect(res.status).toBe(404);
  });
});
