import { Server, createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { GithubAuthService } from '../../src/auth/github.service';
import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfig } from '../../src/config/parser';
import { LoginFlow } from '../../src/db/models';
import { closeSequelize } from '../../src/db/sequelize';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp } from '../helpers/http';

let harness: Harness;
let gh: FakeGithub;
let config: ConfigService;
let github: GithubAuthService;

const CLIENT_ID = 'test-client';
const REDIRECT_URI = 'https://docs.example.test/api/auth/github/callback';

beforeAll(async () => {
  harness = await createHarness();
  gh = await startFakeGithub();
});

beforeEach(() => {
  gh.reset();
  config = new ConfigService(loadInstanceConfig(instanceYaml()));
  github = new GithubAuthService(config);
});

afterAll(async () => {
  await gh?.stop();
  await harness?.close();
  await closeSequelize();
});

function instanceYaml(): string {
  return [
    'version: 1',
    'auth:',
    '  providers:',
    '    hub:',
    '      type: github',
    `      client_id: ${CLIENT_ID}`,
    '      client_secret: a-secret',
    `      base_url: ${gh.base}`,
    'groups:',
    '  engineering:',
    '    - { provider: hub, id: acme/platform }',
    'admins:',
    '  users:',
    '    - provider: hub',
    '      subject: the-administrator',
    '      note: no test here signs in as an admin; `admins` must resolve to somebody',
  ].join('\n');
}

/** Start a sign-in and return the `state` GitHub would hand back */
async function start(): Promise<string> {
  const url = new URL(await github.authorizationUrl(harness.tenantId, 'hub', REDIRECT_URI, '/'));
  return url.searchParams.get('state') as string;
}

describe('the authorization URL', () => {
  it('asks for the scopes team membership and a verified address need', async () => {
    const url = new URL(await github.authorizationUrl(harness.tenantId, 'hub', REDIRECT_URI));

    expect(url.origin).toBe(gh.base);
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('read:org user:email');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('allow_signup')).toBe('false');
  });

  it('sends no PKCE challenge, which these endpoints would ignore', async () => {
    const url = new URL(await github.authorizationUrl(harness.tenantId, 'hub', REDIRECT_URI));

    expect(url.searchParams.get('code_challenge')).toBeNull();
    expect(url.searchParams.get('code_challenge_method')).toBeNull();
  });

  it('stores a single-use flow carrying the redirect target', async () => {
    const state = await start();
    const flow = await LoginFlow.findOne({ where: { state } });

    expect(flow?.provider).toBe('hub');
    expect(flow?.redirect_to).toBe('/');
    // Both columns are NOT NULL and neither is ever sent; filled so no reader of
    // the row takes an empty string for something this flow checks
    expect(flow?.nonce).not.toBe('');
    expect(flow?.code_verifier).not.toBe('');
  });

  it('refuses an absolute redirect target rather than carrying it', async () => {
    const url = new URL(
      await github.authorizationUrl(harness.tenantId, 'hub', REDIRECT_URI, 'https://evil.test/'),
    );
    const flow = await LoginFlow.findOne({ where: { state: url.searchParams.get('state') ?? '' } });

    expect(flow?.redirect_to).toBe('/');
  });
});

describe('a completed sign-in', () => {
  it('keys the identity on the numeric id, not the renameable login', async () => {
    const { identity } = await github.completeLogin(
      harness.tenantId,
      'the-code',
      await start(),
      REDIRECT_URI,
    );

    expect(identity.subject).toBe('4711');
    expect(identity.provider).toBe('hub');
    expect(identity.displayName).toBe('Ada Lovelace');
  });

  it('names teams the way a group source does', async () => {
    const { rawGroupIds } = await github.completeLogin(
      harness.tenantId,
      'the-code',
      await start(),
      REDIRECT_URI,
    );

    expect(rawGroupIds).toEqual(['acme/platform', 'acme/readers']);
    expect(config.resolveInternalGroups('hub', rawGroupIds)).toEqual(['engineering']);
  });

  it('reads every page of teams', async () => {
    gh.teams = [pageOfTeams(100, 'first'), [{ slug: 'platform', organization: { login: 'acme' } }]];

    const { rawGroupIds } = await github.completeLogin(
      harness.tenantId,
      'the-code',
      await start(),
      REDIRECT_URI,
    );

    expect(rawGroupIds).toHaveLength(101);
    expect(rawGroupIds[100]).toBe('acme/platform');
  });

  it('takes the primary verified address', async () => {
    const { identity } = await github.completeLogin(
      harness.tenantId,
      'the-code',
      await start(),
      REDIRECT_URI,
    );

    expect(identity.email).toBe('ada@acme.test');
  });

  it('takes no address when the primary one is unverified', async () => {
    gh.emails = [{ email: 'ada@acme.test', primary: true, verified: false }];

    const { identity } = await github.completeLogin(
      harness.tenantId,
      'the-code',
      await start(),
      REDIRECT_URI,
    );

    expect(identity.email).toBeNull();
  });

  it('takes no address from a verified one that is not primary', async () => {
    gh.emails = [{ email: 'other@acme.test', primary: false, verified: true }];

    const { identity } = await github.completeLogin(
      harness.tenantId,
      'the-code',
      await start(),
      REDIRECT_URI,
    );

    expect(identity.email).toBeNull();
  });

  it('completes without an address when `user:email` was refused', async () => {
    gh.failEmails = 403;

    const { identity, rawGroupIds } = await github.completeLogin(
      harness.tenantId,
      'the-code',
      await start(),
      REDIRECT_URI,
    );

    expect(identity.email).toBeNull();
    expect(identity.subject).toBe('4711');
    expect(rawGroupIds).toEqual(['acme/platform', 'acme/readers']);
  });

  it('completes with no groups when the org withholds the team list', async () => {
    // What an org with OAuth app access restrictions answers: not an error
    gh.teams = [[]];

    const { identity, rawGroupIds } = await github.completeLogin(
      harness.tenantId,
      'the-code',
      await start(),
      REDIRECT_URI,
    );

    expect(rawGroupIds).toEqual([]);
    expect(identity.subject).toBe('4711');
  });

  it('spends the user token on the API host, not the web host', async () => {
    await github.completeLogin(harness.tenantId, 'the-code', await start(), REDIRECT_URI);

    expect(gh.seen).toContain('GET /api/v3/user');
    expect(gh.seen).toContain('POST /login/oauth/access_token');
    expect(gh.bearers).toEqual(['user-token', 'user-token', 'user-token']);
  });
});

describe('a sign-in that should not complete', () => {
  it('refuses a state no flow was stored for', async () => {
    await expect(
      github.completeLogin(harness.tenantId, 'the-code', 'never-issued', REDIRECT_URI),
    ).rejects.toThrow('unknown or reused login state');
  });

  it('refuses the second use of a state', async () => {
    const state = await start();
    await github.completeLogin(harness.tenantId, 'the-code', state, REDIRECT_URI);

    await expect(
      github.completeLogin(harness.tenantId, 'the-code', state, REDIRECT_URI),
    ).rejects.toThrow('unknown or reused login state');
  });

  it('refuses a flow from another tenant', async () => {
    const state = await start();

    await expect(
      github.completeLogin('00000000-0000-0000-0000-000000000000', 'the-code', state, REDIRECT_URI),
    ).rejects.toThrow('unknown or reused login state');
  });

  it('refuses an expired flow, and spends no code doing it', async () => {
    const state = 'a-stale-state';
    await LoginFlow.create({
      tenant_id: harness.tenantId,
      provider: 'hub',
      state,
      nonce: 'unused',
      code_verifier: 'unused',
      redirect_to: '/',
      expires_at: new Date(Date.now() - 1_000),
    });

    await expect(
      github.completeLogin(harness.tenantId, 'the-code', state, REDIRECT_URI),
    ).rejects.toThrow('login flow expired');
    expect(gh.seen).not.toContain('POST /login/oauth/access_token');
  });

  it('refuses a code GitHub rejected, which it reports as a 200', async () => {
    gh.tokenError = 'bad_verification_code';

    await expect(
      github.completeLogin(harness.tenantId, 'the-code', await start(), REDIRECT_URI),
    ).rejects.toThrow('token exchange refused');
  });

  it('refuses a user response carrying no id', async () => {
    gh.user = { login: 'ada' };

    await expect(
      github.completeLogin(harness.tenantId, 'the-code', await start(), REDIRECT_URI),
    ).rejects.toThrow('carried no id');
  });

  it('refuses a provider that is not a github one', async () => {
    await expect(github.authorizationUrl(harness.tenantId, 'nobody', REDIRECT_URI)).rejects.toThrow(
      'is not a github provider',
    );
  });
});

describe('the session lifetime', () => {
  it('defaults to eight hours', () => {
    expect(github.sessionTtlMs('hub')).toBe(8 * 60 * 60_000);
  });

  it('is taken from the provider when it is set', () => {
    config.adopt(
      loadInstanceConfig(
        instanceYaml().replace(
          '      client_secret: a-secret',
          '      client_secret: a-secret\n      session_ttl: 30m',
        ),
      ),
    );

    expect(github.sessionTtlMs('hub')).toBe(30 * 60_000);
  });
});

describe('the sign-in route', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootTestApp(new ConfigService(loadInstanceConfig(instanceYaml())));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('sends the reader to GitHub instead of re-offering the picker', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/auth/login?provider=hub&redirect_to=/handbook')
      .expect(302);

    const location = new URL(response.headers.location as string);
    expect(location.origin).toBe(gh.base);
    expect(location.pathname).toBe('/login/oauth/authorize');
    expect(location.searchParams.get('redirect_uri')).toMatch(/\/api\/auth\/github\/callback$/);
  });

  it('carries the page the reader came from through the flow', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/auth/login?provider=hub&redirect_to=/handbook')
      .expect(302);

    const state = new URL(response.headers.location as string).searchParams.get('state') ?? '';
    expect((await LoginFlow.findOne({ where: { state } }))?.redirect_to).toBe('/handbook');
  });

  it('answers a callback with no code with the sign-in page, not a stack trace', async () => {
    await request(app.getHttpServer()).get('/api/auth/github/callback').expect(400);
  });

  it('answers a callback carrying a state nobody issued the same way', async () => {
    await request(app.getHttpServer())
      .get('/api/auth/github/callback?code=c&state=never-issued')
      .expect(400);
  });

  it('signs the reader in and sets a session cookie', async () => {
    const started = await request(app.getHttpServer())
      .get('/api/auth/login?provider=hub&redirect_to=/handbook')
      .expect(302);
    const state = new URL(started.headers.location as string).searchParams.get('state') ?? '';

    const done = await request(app.getHttpServer())
      .get(`/api/auth/github/callback?code=the-code&state=${encodeURIComponent(state)}`)
      .expect(302);

    expect(done.headers.location).toBe('/handbook');
    expect(String(done.headers['set-cookie'])).toContain('speicher_session=');
  });
});

function pageOfTeams(count: number, org: string): FakeTeam[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `team-${index}`,
    organization: { login: org },
  }));
}

interface FakeTeam {
  slug?: string;
  organization?: { login?: string };
}

interface FakeEmail {
  email: string;
  primary?: boolean;
  verified?: boolean;
}

interface FakeGithub {
  base: string;
  seen: string[];
  bearers: string[];
  user: Record<string, unknown>;
  emails: FakeEmail[];
  /** One entry per page, in order */
  teams: FakeTeam[][];
  tokenError: string | null;
  failEmails: number | null;
  reset(): void;
  stop(): Promise<void>;
}

async function startFakeGithub(): Promise<FakeGithub> {
  const defaults = {
    user: { id: 4711, login: 'ada', name: 'Ada Lovelace' } as Record<string, unknown>,
    emails: [
      { email: 'noreply@acme.test', primary: false, verified: true },
      { email: 'ada@acme.test', primary: true, verified: true },
    ] as FakeEmail[],
    teams: [
      [
        { slug: 'platform', organization: { login: 'acme' } },
        { slug: 'readers', organization: { login: 'acme' } },
      ],
    ] as FakeTeam[][],
  };

  const state: FakeGithub = {
    base: '',
    seen: [],
    bearers: [],
    user: defaults.user,
    emails: defaults.emails,
    teams: defaults.teams,
    tokenError: null,
    failEmails: null,
    reset() {
      state.seen = [];
      state.bearers = [];
      state.user = { ...defaults.user };
      state.emails = [...defaults.emails];
      state.teams = defaults.teams.map((page) => [...page]);
      state.tokenError = null;
      state.failEmails = null;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', state.base);
      const path = url.pathname;
      state.seen.push(`${req.method} ${path}`);

      if (req.method === 'POST' && path === '/login/oauth/access_token') {
        const body = new URLSearchParams(await readBody(req));
        if (body.get('client_id') !== CLIENT_ID) return send(res, 401, { error: 'bad_client' });
        // GitHub reports a refused code as 200 with an `error` member
        if (state.tokenError) return send(res, 200, { error: state.tokenError });
        return send(res, 200, { access_token: 'user-token', token_type: 'bearer' });
      }

      state.bearers.push((req.headers.authorization ?? '').replace(/^Bearer /, ''));

      if (path === '/api/v3/user') return send(res, 200, state.user);

      if (path === '/api/v3/user/emails') {
        if (state.failEmails) return send(res, state.failEmails, { message: 'no' });
        return send(res, 200, state.emails);
      }

      if (path === '/api/v3/user/teams') {
        const page = Number(url.searchParams.get('page') ?? '1');
        return send(res, 200, state.teams[page - 1] ?? []);
      }

      return send(res, 404, { message: 'nope' });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
