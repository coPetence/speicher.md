import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { GraphDirectory, entraPortalGroupUrl } from '../../src/auth/directory/graph';
import {
  DIRECTORY_DEPS,
  createDirectoryLookup,
  groupReach,
  probeDirectory,
} from '../../src/auth/directory/lookup';
import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfig, loadInstanceConfigFromFile } from '../../src/config/parser';
import { FindingList } from '../../src/ingest/findings';
import { DirectoryLookup, resolveAccessBlock } from '../../src/ingest/grants';
import { checkSummary } from '../../src/jobs/registration.service';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

interface FakeGraph {
  base: string;
  authority: string;
  users: Map<string, { id: string; accountEnabled?: boolean; mail?: string }>;
  groups: Map<string, number>;
  /** Group ids each user object id is a transitive member of */
  memberOf: Map<string, string[]>;
  /** The groupIds of each checkMemberGroups request */
  batches: string[][];
  hits: { token: number; user: number; filter: number; count: number };
  fail: number | null;
  failReads: number | null;
  sentToGraph: string[];
  sentToLogin: string[];
  close(): Promise<void>;
}

async function startFakeGraph(): Promise<FakeGraph> {
  const state = {
    users: new Map<string, { id: string; accountEnabled?: boolean; mail?: string }>(),
    groups: new Map<string, number>(),
    memberOf: new Map<string, string[]>(),
    batches: [] as string[][],
    hits: { token: 0, user: 0, filter: 0, count: 0 },
    fail: null as number | null,
    failReads: null as number | null,
    sentToGraph: [] as string[],
    sentToLogin: [] as string[],
  };
  let base = '';

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', base);
      const path = url.pathname;

      if (req.method === 'POST' && path.endsWith('/oauth2/v2.0/token')) {
        state.hits.token += 1;
        state.sentToLogin.push(await readBody(req));
        if (state.fail) return send(res, state.fail, 'text/plain', 'no');
        return send(
          res,
          200,
          'application/json',
          JSON.stringify({ access_token: 'graph-token', expires_in: 3600 }),
        );
      }

      state.sentToGraph.push(String(req.headers.authorization ?? ''));
      const refuse = state.fail ?? state.failReads;
      if (refuse) return send(res, refuse, 'text/plain', 'no');

      if (path === '/v1.0/users') {
        state.hits.filter += 1;
        const filter = url.searchParams.get('$filter') ?? '';
        const wanted = /mail eq '(.*)'$/.exec(filter)?.[1]?.replace(/''/g, "'");
        const rows = [...state.users.entries()]
          .filter(([, user]) => user.mail !== undefined && user.mail === wanted)
          .map(([, user]) => ({ id: user.id }));
        return send(res, 200, 'application/json', JSON.stringify({ value: rows }));
      }

      const checking = /^\/v1\.0\/users\/(.+)\/checkMemberGroups$/.exec(path)?.[1];
      if (req.method === 'POST' && checking) {
        const asked = (JSON.parse(await readBody(req)) as { groupIds: string[] }).groupIds;
        state.batches.push(asked);
        const found = state.users.get(decodeURIComponent(checking));
        if (!found) return send(res, 404, 'application/json', '{}');
        const held = state.memberOf.get(found.id) ?? [];
        return send(
          res,
          200,
          'application/json',
          JSON.stringify({ value: asked.filter((id) => held.includes(id)) }),
        );
      }

      const user = /^\/v1\.0\/users\/(.+)$/.exec(path)?.[1];
      if (user) {
        state.hits.user += 1;
        const found = state.users.get(decodeURIComponent(user));
        if (!found) return send(res, 404, 'application/json', '{}');
        return send(
          res,
          200,
          'application/json',
          JSON.stringify({ id: found.id, accountEnabled: found.accountEnabled ?? true }),
        );
      }

      const group = /^\/v1\.0\/groups\/(.+)\/transitiveMembers\/\$count$/.exec(path)?.[1];
      if (group) {
        state.hits.count += 1;
        if (req.headers.consistencylevel !== 'eventual') {
          return send(res, 400, 'text/plain', 'ConsistencyLevel required');
        }
        const size = state.groups.get(decodeURIComponent(group));
        if (size === undefined) return send(res, 404, 'text/plain', 'no such group');
        return send(res, 200, 'text/plain', String(size));
      }

      return send(res, 404, 'application/json', '{}');
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    users: state.users,
    groups: state.groups,
    memberOf: state.memberOf,
    batches: state.batches,
    hits: state.hits,
    sentToGraph: state.sentToGraph,
    sentToLogin: state.sentToLogin,
    get fail() {
      return state.fail;
    },
    set fail(status: number | null) {
      state.fail = status;
    },
    get failReads() {
      return state.failReads;
    },
    set failReads(status: number | null) {
      state.failReads = status;
    },
    base: `${base}/v1.0`,
    authority: base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

let graph: FakeGraph;

beforeAll(async () => {
  graph = await startFakeGraph();
});

afterAll(async () => {
  await graph?.close();
});

beforeEach(() => {
  graph.users.clear();
  graph.groups.clear();
  graph.memberOf.clear();
  graph.batches.length = 0;
  graph.hits.token = 0;
  graph.hits.user = 0;
  graph.hits.filter = 0;
  graph.hits.count = 0;
  graph.fail = null;
  graph.failReads = null;
  graph.sentToGraph.length = 0;
  graph.sentToLogin.length = 0;
});

function client(cacheTtl = '1h', groupIds: string[] = []): GraphDirectory {
  return new GraphDirectory(
    'entra',
    {
      type: 'graph',
      tenant_id: 'a-tenant',
      client_id: 'graph-client',
      client_secret: 'graph-secret',
      cache_ttl: cacheTtl,
    },
    groupIds,
    { graphBase: graph.base, authority: graph.authority, sleep: async () => {} },
  );
}

const ENTRA_ISSUER = 'https://login.microsoftonline.com/a-tenant/v2.0';

function configFor(yaml: string): ConfigService {
  return new ConfigService(loadInstanceConfig(yaml));
}

const WITH_DIRECTORY = `
version: 1
# The magic-link provider is here to be the *other* provider — one lookup serves
# every provider, and the absent case is what must not read as a departure. It
# brings the transport with it, which the loader requires of that kind.
mail:
  host: smtp.example.test
  from: Docs <docs@example.test>
auth:
  providers:
    entra:
      type: oidc
      issuer: ${ENTRA_ISSUER}
      client_id: sign-in-client
      client_secret: sign-in-secret
      subject_claim: oid
      directory:
        type: graph
        tenant_id: a-tenant
        client_id: graph-client
        client_secret: graph-secret
    letter:
      type: magic-link
groups:
  engineering:
    - { provider: entra, id: grp-eng }
  commercial:
    - { provider: entra, id: grp-com }
    - { provider: entra, id: grp-sales }
  named:
    - { provider: entra, subject: person-one, note: a person }
    - { provider: entra, subject: person-two, note: another }
  lapsed:
    - { provider: entra, id: grp-eng, until: '2020-01-01', note: expired }
`;

describe('the Graph client', () => {
  it('mints an app-only token once and sends it to Graph, never the secret', async () => {
    graph.users.set('alice@example.test', { id: 'oid-alice' });
    graph.users.set('oid-alice', { id: 'oid-alice' });
    const directory = client();

    expect(await directory.resolveEmail('alice@example.test')).toBe('oid-alice');
    expect(await directory.subjectExists('oid-alice')).toBe(true);

    expect(graph.hits.token).toBe(1);
    expect(graph.sentToGraph).toEqual(['Bearer graph-token', 'Bearer graph-token']);
    expect(graph.sentToLogin.join()).toContain('graph-secret');
    expect(graph.sentToGraph.join()).not.toContain('graph-secret');
  });

  it('finds an address that is not the sign-in name, by asking a second way', async () => {
    graph.users.set('a.person@corp.example', { id: 'oid-a', mail: 'alice@example.test' });

    expect(await client().resolveEmail('alice@example.test')).toBe('oid-a');
    expect(graph.hits.user).toBe(1);
    expect(graph.hits.filter).toBe(1);
  });

  it('resolves an address two accounts share to nobody', async () => {
    graph.users.set('one', { id: 'oid-one', mail: 'shared@example.test' });
    graph.users.set('two', { id: 'oid-two', mail: 'shared@example.test' });

    expect(await client().resolveEmail('shared@example.test')).toBeNull();
  });

  it('treats a disabled account as gone, and an unknown one as gone', async () => {
    graph.users.set('oid-left', { id: 'oid-left', accountEnabled: false });
    const directory = client();

    expect(await directory.subjectExists('oid-left')).toBe(false);
    expect(await directory.subjectExists('oid-never')).toBe(false);
  });

  it('counts a group transitively, and says nothing about one it does not have', async () => {
    graph.groups.set('grp-eng', 214);
    const directory = client();

    expect(await directory.groupSize('grp-eng')).toBe(214);
    expect(await directory.groupSize('grp-missing')).toBeNull();
  });

  it('asks once and remembers, including the answer that was no', async () => {
    graph.users.set('alice@example.test', { id: 'oid-alice' });
    const directory = client();

    await directory.resolveEmail('alice@example.test');
    await directory.resolveEmail('alice@example.test');
    await directory.resolveEmail('nobody@example.test');
    await directory.resolveEmail('nobody@example.test');

    expect(graph.hits.user).toBe(2);
  });

  it('forgets the answer once the configured lifetime has passed', async () => {
    graph.users.set('alice@example.test', { id: 'oid-alice' });
    const directory = client('1s');
    await directory.resolveEmail('alice@example.test');

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await directory.resolveEmail('alice@example.test');
    expect(graph.hits.user).toBe(2);
  });

  it('refuses to say anything after a failure, rather than saying no', async () => {
    graph.fail = 500;
    const directory = client();

    await expect(directory.resolveEmail('alice@example.test')).rejects.toFailWith(
      'directory.unavailable',
    );
    await expect(directory.subjectExists('oid-alice')).rejects.toFailWith('directory.unavailable');
    const asked = graph.hits.token;
    await expect(directory.resolveEmail('bob@example.test')).rejects.toFailWith(
      'directory.unavailable',
    );
    expect(graph.hits.token).toBe(asked);
  });

  it('gives up a size quietly, which is the one question that never throws', async () => {
    graph.fail = 503;
    expect(await client().groupSize('grp-eng')).toBeNull();
  });
});

describe('the groups somebody is in now', () => {
  it('are the configured ones they are a member of, and no others', async () => {
    graph.users.set('oid-alice', { id: 'oid-alice' });
    graph.memberOf.set('oid-alice', ['grp-eng', 'grp-unconfigured']);

    expect(await client('1h', ['grp-com', 'grp-eng']).groupsFor('oid-alice')).toEqual(['grp-eng']);
    expect(graph.batches).toEqual([['grp-com', 'grp-eng']]);
  });

  it('are asked about twenty at a time, the most Graph accepts', async () => {
    const ids = Array.from({ length: 45 }, (_, i) => `grp-${String(i).padStart(2, '0')}`);
    graph.users.set('oid-alice', { id: 'oid-alice' });
    graph.memberOf.set('oid-alice', ['grp-03', 'grp-27', 'grp-44']);

    expect(await client('1h', ids).groupsFor('oid-alice')).toEqual(['grp-03', 'grp-27', 'grp-44']);
    expect(graph.batches.map((batch) => batch.length)).toEqual([20, 20, 5]);
  });

  it('are none for an account that is gone, which is an answer and not a failure', async () => {
    expect(await client('1h', ['grp-eng']).groupsFor('oid-never')).toEqual([]);
  });

  it('are asked again when the caller wants them fresh', async () => {
    graph.users.set('oid-alice', { id: 'oid-alice' });
    const directory = client('1h', ['grp-eng']);

    await directory.groupsFor('oid-alice');
    await directory.groupsFor('oid-alice');
    expect(graph.batches).toHaveLength(1);

    graph.memberOf.set('oid-alice', ['grp-eng']);
    expect(await directory.groupsFor('oid-alice', { fresh: true })).toEqual(['grp-eng']);
    expect(graph.batches).toHaveLength(2);
  });

  it('cannot be said when Graph cannot be reached', async () => {
    graph.failReads = 503;
    expect(await client('1h', ['grp-eng']).groupsFor('oid-alice')).toBeNull();
  });
});

describe('the connection check', () => {
  it('proves a read rather than a token, since consent is the half that is missed', async () => {
    graph.users.set('somebody', { id: 'oid-1' });
    const status = await client().probe();

    expect(status).toMatchObject({ code: 'directory.connected', level: 'ok' });
    expect(graph.hits.filter).toBe(1);
  });

  it('answers rather than throws, and names the permission it was refused for', async () => {
    graph.failReads = 403;
    const status = await client().probe();

    expect(status).toMatchObject({
      code: 'directory.unreachable',
      level: 'fail',
      facts: { kind: 'credentials-refused' },
    });
  });

  it('says the credentials failed when it is the token that will not mint', async () => {
    graph.fail = 401;
    const status = await client().probe();
    expect(status).toMatchObject({
      code: 'directory.unreachable',
      level: 'fail',
      facts: { kind: 'token-refused' },
    });
  });

  it('asks again after a failure, rather than repeating a stale verdict', async () => {
    const directory = client();
    graph.fail = 500;
    expect((await directory.probe()).level).toBe('fail');

    graph.fail = null;
    graph.users.set('somebody', { id: 'oid-1' });
    expect((await client().probe()).level).toBe('ok');
  });

  it('holds its answer briefly, so a page render is not a request', async () => {
    graph.users.set('somebody', { id: 'oid-1' });
    const directory = client();
    await directory.probe();
    await directory.probe();
    expect(graph.hits.filter).toBe(1);
  });

  it('says nothing at all about a provider with no directory', async () => {
    const bare = configFor('version: 1\n');
    expect(await probeDirectory(bare, 'entra')).toBeNull();
    expect(
      await probeDirectory(configFor(WITH_DIRECTORY), 'letter', {
        graphBase: graph.base,
        authority: graph.authority,
      }),
    ).toBeNull();
  });

  it('answers about the provider it was asked about', async () => {
    graph.users.set('somebody', { id: 'oid-1' });
    const status = await probeDirectory(configFor(WITH_DIRECTORY), 'entra', {
      graphBase: graph.base,
      authority: graph.authority,
      sleep: async () => {},
    });
    expect(status?.level).toBe('ok');
  });
});

describe('the lookup over several providers', () => {
  it('covers the provider that has a directory and no other', () => {
    const lookup = createDirectoryLookup(configFor(WITH_DIRECTORY), {
      graphBase: graph.base,
      authority: graph.authority,
    })!;
    expect(lookup.covers('entra')).toBe(true);
    expect(lookup.covers('letter')).toBe(false);
  });

  it('keeps a grant on a provider it does not cover', async () => {
    const lookup = createDirectoryLookup(configFor(WITH_DIRECTORY), {
      graphBase: graph.base,
      authority: graph.authority,
    })!;
    expect(await lookup.subjectExists('letter', 'someone@example.test')).toBe(true);
    expect(graph.hits.token).toBe(0);
  });

  it('is absent entirely for an instance that configures none', () => {
    const bare = configFor('version: 1\n');
    expect(createDirectoryLookup(bare, { graphBase: graph.base })).toBeUndefined();
  });
});

describe('how far a group reaches', () => {
  const lookupFor = () =>
    createDirectoryLookup(configFor(WITH_DIRECTORY), {
      graphBase: graph.base,
      authority: graph.authority,
      sleep: async () => {},
    });

  it('adds up every mapping the name draws from', async () => {
    graph.groups.set('grp-com', 30);
    graph.groups.set('grp-sales', 12);
    const [reach] = await groupReach(configFor(WITH_DIRECTORY), lookupFor(), ['commercial']);
    expect(reach.size).toBe(42);
  });

  it('counts people named in the document without asking anybody', async () => {
    const [reach] = await groupReach(configFor(WITH_DIRECTORY), lookupFor(), ['named']);
    expect(reach.size).toBe(2);
    expect(graph.hits.token).toBe(0);
    expect(reach.directoryUrl).toBe('');
  });

  it('leaves the total unknown when a mapping could not be counted', async () => {
    graph.groups.set('grp-com', 30);
    const [reach] = await groupReach(configFor(WITH_DIRECTORY), lookupFor(), ['commercial']);
    expect(reach.size).toBeNull();
  });

  it('gives an expired mapping no readers at all', async () => {
    graph.groups.set('grp-eng', 214);
    const [reach] = await groupReach(configFor(WITH_DIRECTORY), lookupFor(), ['lapsed']);
    expect(reach.size).toBeNull();
    expect(graph.hits.count).toBe(0);
  });

  it('has nothing to count with no directory, and still says where to look', async () => {
    const [reach] = await groupReach(configFor(WITH_DIRECTORY), undefined, ['engineering']);
    expect(reach.size).toBeNull();
    expect(reach.directoryUrl).toContain('groupId/grp-eng');
  });

  it('links only where the provider is one whose portal this is', async () => {
    const other = WITH_DIRECTORY.replace(ENTRA_ISSUER, 'https://issuer.example.test/v2.0').replace(
      / {6}directory:\n(?: {8}.+\n)+/,
      '',
    );
    const [reach] = await groupReach(configFor(other), undefined, ['engineering']);
    expect(reach.directoryUrl).toBe('');
  });

  it('refuses to build a link out of an id that is not shaped like one', () => {
    expect(entraPortalGroupUrl('grp-eng')).toContain('groupId/grp-eng');
    expect(entraPortalGroupUrl('../../evil')).toBe('');
    expect(entraPortalGroupUrl('javascript:alert(1)')).toBe('');
    expect(entraPortalGroupUrl('')).toBe('');
  });
});

describe('the pull-request check', () => {
  const lookupFor = () =>
    createDirectoryLookup(configFor(WITH_DIRECTORY), {
      graphBase: graph.base,
      authority: graph.authority,
      sleep: async () => {},
    });

  const walkOf = (...principals: string[][]) => ({
    documents: principals.map((p) => ({ principals: p })),
    assets: [],
  });

  it('says how far the access in the change reaches, and where to look', async () => {
    graph.groups.set('grp-eng', 214);
    const summary = await checkSummary(
      configFor(WITH_DIRECTORY),
      lookupFor(),
      '',
      walkOf(['group:engineering', 'user:entra:oid-alice']),
    );

    expect(summary).toContain('- `engineering` — up to 214 reader(s)');
    expect(summary).toContain('groupId/grp-eng');
    expect(summary).not.toContain('commercial');
  });

  it('names a group it could not size rather than leaving it out', async () => {
    const summary = await checkSummary(
      configFor(WITH_DIRECTORY),
      lookupFor(),
      '',
      walkOf(['group:engineering']),
    );
    expect(summary).toContain('- `engineering` — size unknown');
  });

  it('keeps saying why there are no sizes on an instance with no directory', async () => {
    const summary = await checkSummary(
      configFor(WITH_DIRECTORY.replace(/ {6}directory:\n(?: {8}.+\n)+/, '')),
      undefined,
      '',
      walkOf(['group:engineering']),
    );
    expect(summary).toContain('Group sizes are not shown');
    expect(summary).not.toContain('reaches:');
  });
});

function fieldAt(
  value: unknown,
  path: string,
): { path: string; status?: { level: string; label: string }; checkHref?: string } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.path === path) return record as never;
  for (const child of Object.values(record)) {
    const found = fieldAt(child, path);
    if (found) return found;
  }
  return undefined;
}

describe('the check on the provider page', () => {
  let harness: Harness;
  let app: INestApplication;
  let ops: string;

  const WITH_GRAPH = `${WITH_DIRECTORY}
  platform-ops:
    - { provider: entra, id: grp-ops }

admins:
  groups: [platform-ops]
`;

  let dir: string;

  beforeAll(async () => {
    harness = await createHarness();
    ops = await sessionCookieFor(harness.tenantId, 'ops');
    dir = mkdtempSync(join(tmpdir(), 'speicher-directory-'));
    const path = join(dir, 'instance.yaml');
    writeFileSync(path, WITH_GRAPH, 'utf8');

    app = await bootTestApp(
      new ConfigService(loadInstanceConfigFromFile(path)),
      [],
      [{ token: DIRECTORY_DEPS, value: { graphBase: graph.base, authority: graph.authority } }],
    );
  });

  afterAll(async () => {
    await app?.close();
    await harness?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const page = (query = '') =>
    request(app.getHttpServer())
      .get(`/-/config/identity/entra${query}`)
      .set('cookie', ops)
      .expect(200);

  it('offers the check under the control that turns the lookup on, and does not make it', async () => {
    graph.users.set('somebody', { id: 'oid-1' });
    const before = { ...graph.hits };
    const { text } = await page();

    expect({ ...graph.hits }).toEqual(before);
    expect(text).toContain('data-spr-check="/-/config/identity/entra?check=1"');
    expect(text).toContain('Check the connection');
    expect(text).toContain('data-spr-check-at="auth.providers.entra.directory.type"');
    expect(text.indexOf('data-spr-check-at')).toBeGreaterThan(
      text.indexOf('name="auth.providers.entra.directory.type"'),
    );
  });

  it('draws the connection under that same control once it is asked', async () => {
    graph.users.set('somebody', { id: 'oid-1' });
    const { text } = await page('?check=1');

    expect(text).toContain('spr-note-ok');
    expect(text).toContain('Connected');
    expect(text.indexOf('Connected')).toBeGreaterThan(
      text.indexOf('name="auth.providers.entra.directory.type"'),
    );
  });

  it('answers the island out of the same request', async () => {
    graph.users.set('somebody', { id: 'oid-1' });
    const { body } = await request(app.getHttpServer())
      .get('/-/config/identity/entra?check=1')
      .set('cookie', ops)
      .set('accept', 'application/json')
      .expect(200);

    const field = fieldAt(body.section, 'auth.providers.entra.directory.type');
    expect(field?.status).toMatchObject({ code: 'directory.connected', level: 'ok' });
    expect(field?.checkHref).toBeUndefined();
  });

  it('says so on the page when the directory refuses the credentials', async () => {
    graph.failReads = 403;
    const { text } = await page('?check=1');

    expect(text).toContain('spr-note-fail');
    expect(text).toContain('Not connected');
    expect(text).toContain('User.Read.All');
  });
});

describe('a grant resolved against the directory', () => {
  const config = () => configFor(WITH_DIRECTORY);
  const lookup = (): DirectoryLookup =>
    createDirectoryLookup(config(), {
      graphBase: graph.base,
      authority: graph.authority,
      sleep: async () => {},
    })!;

  async function resolve(
    users: { provider?: string; subject?: string; email?: string; note?: string }[],
    directory: DirectoryLookup | undefined,
  ) {
    const findings = new FindingList();
    const result = await resolveAccessBlock(
      { users },
      {
        config: config(),
        directory,
        source: '.speicher.yaml',
        now: new Date('2026-01-01T00:00:00Z'),
        requireUntil: false,
        expiryWarningMs: 0,
        publicGrant: 'disabled',
      },
      findings,
    );
    return { result, findings };
  }

  it('stores the person, not the address', async () => {
    graph.users.set('alice@example.test', { id: 'oid-alice' });
    const { result } = await resolve(
      [{ provider: 'entra', email: 'alice@example.test' }],
      lookup(),
    );

    expect(result.principals).toEqual(['user:entra:oid-alice']);
  });

  it('matches the address when there is no directory to ask', async () => {
    const { result } = await resolve(
      [{ provider: 'entra', email: 'alice@example.test' }],
      undefined,
    );
    expect(result.principals).toEqual(['user:entra:email:alice@example.test']);
  });

  it('drops a grant for somebody who has left, and says so', async () => {
    const { result, findings } = await resolve(
      [{ provider: 'entra', subject: 'oid-left', note: 'a colleague' }],
      lookup(),
    );

    expect(result.principals).toEqual([]);
    expect(result.dropped).toEqual([
      { principal: 'user:entra:oid-left', reason: 'no longer in directory' },
    ]);
    expect(findings.all.map((f) => f.code)).toContain('grant-unresolved');
  });

  it('keeps every grant when the directory cannot answer', async () => {
    graph.fail = 500;
    const { result, findings } = await resolve(
      [
        { provider: 'entra', subject: 'oid-alice', note: 'a colleague' },
        { provider: 'entra', email: 'bob@example.test' },
      ],
      lookup(),
    );

    expect(result.principals).toEqual([
      'user:entra:email:bob@example.test',
      'user:entra:oid-alice',
    ]);
    expect(result.dropped).toEqual([]);

    const unavailable = findings.all.filter((f) => f.code === 'directory-unavailable');
    expect(unavailable).toHaveLength(2);
    expect(unavailable[0].severity).toBe('info');
    expect(unavailable[0].adminMessage).toContain('entra');
  });
});
