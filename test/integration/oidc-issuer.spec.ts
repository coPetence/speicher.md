import { Server, createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import { KeyLike, SignJWT, exportJWK, generateKeyPair } from 'jose';

import { OidcService } from '../../src/auth/oidc.service';
import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfig } from '../../src/config/parser';
import { LoginFlow } from '../../src/db/models';
import { closeSequelize } from '../../src/db/sequelize';
import { Harness, createHarness } from '../helpers/harness';

let harness: Harness;
let idp: FakeIdp;
let config: ConfigService;
let oidc: OidcService;
let flows = 0;

const CLIENT_ID = 'test-client';
const REDIRECT_URI = 'https://docs.example.test/-/auth/callback';

beforeAll(async () => {
  harness = await createHarness();
  idp = await startFakeIdp();
});

beforeEach(() => {
  idp.hits.a = { discovery: 0, jwks: 0, token: 0 };
  idp.hits.b = { discovery: 0, jwks: 0, token: 0 };
  config = new ConfigService(loadInstanceConfig(instanceYaml(idp.issuer('a'))));
  oidc = new OidcService(config);
});

afterAll(async () => {
  await idp?.stop();
  await harness?.close();
  await closeSequelize();
});

function instanceYaml(issuer: string): string {
  return [
    'version: 1',
    'auth:',
    '  providers:',
    '    entra:',
    '      type: oidc',
    `      issuer: ${issuer}`,
    `      client_id: ${CLIENT_ID}`,
    'admins:',
    '  users:',
    '    - provider: entra',
    '      subject: the-administrator',
    '      note: this test never signs in as an admin; `admins` must resolve to somebody',
  ].join('\n');
}

function repointTo(issuerId: IssuerId): void {
  config.adopt(loadInstanceConfig(instanceYaml(idp.issuer(issuerId))));
}

async function login(signedBy: IssuerId): Promise<string> {
  const state = `state-${++flows}`;
  const nonce = `nonce-${flows}`;
  await LoginFlow.create({
    tenant_id: harness.tenantId,
    provider: 'entra',
    state,
    nonce,
    code_verifier: 'verifier',
    redirect_to: '/',
    expires_at: new Date(Date.now() + 60_000),
  });
  const { identity } = await oidc.completeLogin(
    harness.tenantId,
    `${nonce}.${signedBy}`,
    state,
    REDIRECT_URI,
  );
  return identity.subject;
}

describe('a provider repointed at another issuer', () => {
  it('transacts the next login with the new issuer, not the cached one', async () => {
    expect(await login('a')).toBe('subject-from-a');
    expect(idp.hits.a).toEqual({ discovery: 1, jwks: 1, token: 1 });

    repointTo('b');
    expect(await login('b')).toBe('subject-from-b');

    expect(idp.hits.b).toEqual({ discovery: 1, jwks: 1, token: 1 });
    expect(idp.hits.a).toEqual({ discovery: 1, jwks: 1, token: 1 });
  });

  it('refuses a token signed by the directory it was moved away from', async () => {
    await login('a');
    repointTo('b');

    await expect(login('a')).rejects.toThrow();
  });

  it('still verifies against the issuer it was moved *to*, not merely refusing everything', async () => {
    await login('a');
    repointTo('b');
    await expect(login('a')).rejects.toThrow();
    expect(await login('b')).toBe('subject-from-b');
  });

  it('is not fooled by a trailing slash into fetching the same issuer twice', async () => {
    await login('a');
    config.adopt(loadInstanceConfig(instanceYaml(`${idp.issuer('a')}/`)));
    await login('a');

    expect(idp.hits.a.discovery).toBe(1);
  });
});

describe('the caches', () => {
  it('are still caches: an unchanged provider discovers once', async () => {
    await login('a');
    await login('a');
    await login('a');
    expect(idp.hits.a.discovery).toBe(1);
  });
});

type IssuerId = 'a' | 'b';

interface Hits {
  discovery: number;
  jwks: number;
  token: number;
}

interface FakeIdp {
  issuer(id: IssuerId): string;
  hits: Record<IssuerId, Hits>;
  stop(): Promise<void>;
}

async function startFakeIdp(): Promise<FakeIdp> {
  const keys: Record<IssuerId, { publicKey: KeyLike; privateKey: KeyLike }> = {
    a: await generateKeyPair('RS256'),
    b: await generateKeyPair('RS256'),
  };
  const hits: Record<IssuerId, Hits> = {
    a: { discovery: 0, jwks: 0, token: 0 },
    b: { discovery: 0, jwks: 0, token: 0 },
  };

  let base = '';
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', base);
      const [, id, ...rest] = url.pathname.split('/');
      const issuerId = id as IssuerId;
      if (issuerId !== 'a' && issuerId !== 'b') return send(res, 404, {});
      const path = rest.join('/');
      const issuer = `${base}/${issuerId}`;

      if (path === '.well-known/openid-configuration') {
        hits[issuerId].discovery += 1;
        return send(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      }

      if (path === 'jwks') {
        hits[issuerId].jwks += 1;
        const jwk = await exportJWK(keys[issuerId].publicKey);
        return send(res, 200, { keys: [{ ...jwk, kid: issuerId, alg: 'RS256', use: 'sig' }] });
      }

      if (path === 'token') {
        hits[issuerId].token += 1;
        const body = new URLSearchParams(await readBody(req));
        const [nonce, signedBy] = (body.get('code') ?? '').split('.');
        const signer = signedBy as IssuerId;
        const idToken = await new SignJWT({ nonce, email: `someone@${issuerId}.test` })
          .setProtectedHeader({ alg: 'RS256', kid: signer })
          .setIssuer(issuer)
          .setAudience(CLIENT_ID)
          .setSubject(`subject-from-${issuerId}`)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(keys[signer].privateKey);
        return send(res, 200, { id_token: idToken });
      }

      return send(res, 404, {});
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer: (id) => `${base}/${id}`,
    hits,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function send(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
