import { createHmac } from 'node:crypto';
import { Server, createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { exportPKCS8, generateKeyPair } from 'jose';

import { GithubDirectory } from '../../src/auth/directory/github';
import { splitTeam } from '../../src/auth/directory/github-config';
import {
  createDirectoryLookup,
  hasDirectory,
  probeDirectory,
} from '../../src/auth/directory/lookup';
import { ConfigService } from '../../src/config/config.service';
import { DirectoryConfig } from '../../src/config/types';
import { loadInstanceConfig } from '../../src/config/parser';
import { DirectoryWebhookController } from '../../src/auth/directory/webhook.controller';
import { SESSION_COOKIE, SessionService } from '../../src/auth/session.service';
import { TenancyService } from '../../src/db/tenancy';
import { hashToken, mintToken } from '../../src/auth/tokens';
import { Session } from '../../src/db/models';
import { closeSequelize } from '../../src/db/sequelize';
import { FindingList } from '../../src/ingest/findings';
import {
  DirectoryLookup,
  DirectoryUnavailableError,
  resolveAccessBlock,
} from '../../src/ingest/grants';
import { Harness, createHarness } from '../helpers/harness';

let harness: Harness;
let gh: FakeGithub;

const ADA = '4711';

beforeAll(async () => {
  harness = await createHarness();
  gh = await startFakeGithub();
});

beforeEach(() => {
  gh.reset();
});

afterAll(async () => {
  await gh?.stop();
  await harness?.close();
  await closeSequelize();
});

function instanceYaml(teams = ['acme/platform'], cacheTtl = '1h'): string {
  return [
    'version: 1',
    'auth:',
    '  providers:',
    '    hub:',
    '      type: github',
    '      client_id: a-client',
    '      client_secret: a-secret',
    // The directory reads the API host from the provider, so one `base_url` points
    // the whole flow at the fake -- and no content source is configured at all,
    // which is the point: the directory holds its own App
    `      base_url: ${gh.base}`,
    '      directory:',
    '        type: github',
    `        app_id: '2'`,
    '        private_key: ${TEST_APP_KEY}',
    `        cache_ttl: ${cacheTtl}`,
    'groups:',
    '  engineering:',
    ...teams.map((team) => `    - { provider: hub, id: ${team} }`),
    'admins:',
    '  users:',
    '    - provider: hub',
    '      subject: the-administrator',
    '      note: no test here signs in as an admin; `admins` must resolve to somebody',
  ].join('\n');
}

function configFor(teams?: string[], cacheTtl?: string): ConfigService {
  return new ConfigService(loadInstanceConfig(instanceYaml(teams, cacheTtl)));
}

/** The provider's own `directory` block, credentials and all */
function directoryConfig(config: ConfigService): DirectoryConfig {
  return (config.provider('hub') as { directory: DirectoryConfig }).directory;
}

function directoryFor(teams: string[] = ['acme/platform']): GithubDirectory {
  const config = configFor(teams);
  return new GithubDirectory('hub', directoryConfig(config), config, teams);
}

describe('a team id', () => {
  it('splits into the organisation and the team', () => {
    expect(splitTeam('acme/platform')).toEqual(['acme', 'platform']);
  });

  it('is not a team when it names no organisation, or more than one level', () => {
    expect(splitTeam('platform')).toEqual([null, null]);
    expect(splitTeam('/platform')).toEqual([null, null]);
    expect(splitTeam('acme/')).toEqual([null, null]);
    expect(splitTeam('acme/sub/team')).toEqual([null, null]);
  });
});

describe('the size of a team', () => {
  it('is the member count the organisation reports', async () => {
    expect(await directoryFor().groupSize('acme/platform')).toBe(7);
  });

  it('is unknown for a team that is not there', async () => {
    expect(await directoryFor().groupSize('acme/ghosts')).toBeNull();
  });

  it('is unknown for an id that is not a team id', async () => {
    expect(await directoryFor().groupSize('platform')).toBeNull();
  });

  it('is asked for once, then cached', async () => {
    const directory = directoryFor();
    await directory.groupSize('acme/platform');
    await directory.groupSize('acme/platform');

    expect(gh.seen.filter((call) => call.endsWith('/teams/platform'))).toHaveLength(1);
  });

  it('finds its own installation and mints a token for it', async () => {
    await directoryFor().groupSize('acme/platform');

    expect(gh.seen).toContain('GET /api/v3/app/installations');
    expect(gh.seen).toContain('POST /api/v3/app/installations/90001/access_tokens');
    // Both app-level calls are signed as the App; neither reuses an installation token
    expect(gh.appJwts).toHaveLength(2);
    expect(gh.appJwts.every((jwt) => jwt.split('.').length === 3)).toBe(true);
  });

  it('asks which organisations it reaches once, then remembers', async () => {
    const directory = directoryFor(['acme/platform', 'acme/readers']);
    await directory.groupSize('acme/platform');
    await directory.groupSize('acme/readers');

    expect(gh.seen.filter((call) => call === 'GET /api/v3/app/installations')).toHaveLength(1);
  });

  it('needs no content source to be configured at all', async () => {
    // The whole point of the separate App: nothing in `forges` is involved
    expect(configFor().forgeIds).toEqual([]);
    expect(await directoryFor().groupSize('acme/platform')).toBe(7);
  });
});

describe('whether somebody is still there', () => {
  it('is yes for an active member of an organisation grants name', async () => {
    expect(await directoryFor().subjectExists(ADA)).toBe(true);
  });

  it('is no for an account that still exists but has left the organisation', async () => {
    gh.memberships.clear();

    expect(await directoryFor().subjectExists(ADA)).toBe(false);
  });

  it('is no for an account that is gone', async () => {
    expect(await directoryFor().subjectExists('9999')).toBe(false);
  });

  it('is yes when no group source names an organisation to ask about', async () => {
    const config = configFor();
    const directory = new GithubDirectory('hub', directoryConfig(config), config, []);

    expect(await directory.subjectExists(ADA)).toBe(true);
    expect(gh.seen).toEqual([]);
  });

  it('looks in every organisation grants name, not only the first', async () => {
    expect(await directoryFor(['other/people', 'acme/platform']).subjectExists(ADA)).toBe(true);
  });
});

describe('the teams somebody is in now', () => {
  it('are the configured ones they are an active member of', async () => {
    gh.teamMembers = new Map([
      ['acme/platform', ['ada']],
      ['acme/readers', []],
    ]);

    expect(await directoryFor(['acme/platform', 'acme/readers']).groupsFor(ADA)).toEqual([
      'acme/platform',
    ]);
  });

  it('are asked for per configured team, not by listing everything', async () => {
    await directoryFor(['acme/platform', 'acme/readers']).groupsFor(ADA);

    expect(gh.seen.filter((call) => call.includes('/memberships/ada'))).toEqual([
      'GET /api/v3/orgs/acme/teams/platform/memberships/ada',
      'GET /api/v3/orgs/acme/teams/readers/memberships/ada',
    ]);
  });

  it('exclude a team the person is only invited to', async () => {
    gh.pending = ['acme/platform'];

    expect(await directoryFor().groupsFor(ADA)).toEqual([]);
  });

  it('are none for an account that is gone, which is an answer and not a failure', async () => {
    expect(await directoryFor().groupsFor('9999')).toEqual([]);
  });

  it('cannot be said when no app reaches the organisation', async () => {
    expect(await directoryFor(['nowhere/team']).groupsFor(ADA)).toBeNull();
  });

  it('cannot be said when the organisation refuses to be read', async () => {
    gh.failOrgReads = 403;

    expect(await directoryFor().groupsFor(ADA)).toBeNull();
  });

  it('skip a team of an organisation no app reaches, and keep the rest', async () => {
    expect(await directoryFor(['nowhere/team', 'acme/platform']).groupsFor(ADA)).toEqual([
      'acme/platform',
    ]);
  });
});

describe('an address', () => {
  it('is never resolved, because GitHub offers no way to ask', async () => {
    expect(await directoryFor().resolveEmail('ada@acme.test')).toBeUndefined();
  });
});

describe('an `email:` grant on a provider with this directory', () => {
  async function resolve(directory: DirectoryLookup | undefined) {
    const findings = new FindingList();
    const result = await resolveAccessBlock(
      { users: [{ provider: 'hub', email: 'ada@acme.test' }] },
      {
        config: configFor(),
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

  it('survives, matching on the address as it would with no directory at all', async () => {
    const lookup = createDirectoryLookup(configFor(), {})!;
    expect(lookup.covers('hub')).toBe(true);

    const { result } = await resolve(lookup);

    // The regression this guards: an unanswerable lookup returning `null` instead
    // of `undefined` reads as "no longer in the directory" and drops the grant
    expect(result.principals).toEqual(['user:hub:email:ada@acme.test']);
    expect(result.dropped).toEqual([]);
  });

  it('resolves the same way the directory is absent', async () => {
    const { result } = await resolve(undefined);

    expect(result.principals).toEqual(['user:hub:email:ada@acme.test']);
  });
});

describe('a directory that cannot read the organisation', () => {
  it('reports unavailable rather than reporting everybody as departed', async () => {
    gh.failOrgReads = 403;

    expect(await detailOf(() => directoryFor().subjectExists(ADA))).toMatch(/Members: Read-only/);
  });

  it('keeps an individual grant, since a refusal is not evidence of absence', async () => {
    gh.failOrgReads = 403;
    const lookup = createDirectoryLookup(configFor(), {})!;
    const findings = new FindingList();

    const result = await resolveAccessBlock(
      { users: [{ provider: 'hub', subject: ADA, note: 'a person' }] },
      {
        config: configFor(),
        directory: lookup,
        source: '.speicher.yaml',
        now: new Date('2026-01-01T00:00:00Z'),
        requireUntil: false,
        expiryWarningMs: 0,
        publicGrant: 'disabled',
      },
      findings,
    );

    expect(result.principals).toEqual([`user:hub:${ADA}`]);
    expect(result.dropped).toEqual([]);
  });

  it('answers an unknown size rather than throwing out of the admin page', async () => {
    gh.failOrgReads = 500;

    expect(await directoryFor().groupSize('acme/platform')).toBeNull();
  });
});

describe('the connection check', () => {
  it('is offered at all, which is what the provider page gates the button on', async () => {
    const config = configFor();

    // The gate used to ask for a Graph directory, so a GitHub one was quietly
    // given no check -- and its commonest failure is invisible without one
    expect(hasDirectory(config, 'hub')).toBe(true);
    expect(await probeDirectory(config, 'hub', {})).toMatchObject({ level: 'ok' });
  });

  it('passes when a configured team can be read', async () => {
    expect(await directoryFor().probe()).toMatchObject({ level: 'ok' });
  });

  it('fails when the App cannot read members, which reading the org alone would miss', async () => {
    // `GET /orgs/{org}` needs only Metadata, so a check pointed at it would pass
    // here and then refuse every question the page asks on the directory's behalf
    gh.failTeamReads = 403;

    expect(await directoryFor().probe()).toMatchObject({ level: 'fail' });
    expect(gh.seen).toContain('GET /api/v3/orgs/acme/teams/platform');
  });

  it('fails when the team named by a group source is not there', async () => {
    gh.teams = new Map();

    const status = await directoryFor().probe();
    expect(status.level).toBe('fail');
    expect(status.detail).toMatch(/the team "platform" cannot be found in "acme"/);
  });

  it('fails when no App reaches the organisation', async () => {
    expect(await directoryFor(['nowhere/team']).probe()).toMatchObject({ level: 'fail' });
  });

  it('says there is nothing to reach when no group source names an organisation', async () => {
    const config = configFor();
    const directory = new GithubDirectory('hub', directoryConfig(config), config, []);

    expect(await directory.probe()).toMatchObject({ label: 'Nothing to reach' });
  });
});

describe('installing the App while the instance is running', () => {
  /** A directory whose clock we can move past the probe's own debounce */
  function withClock(teams: string[] = ['acme/platform']) {
    let now = Date.now();
    const config = configFor(teams);
    const directory = new GithubDirectory('hub', directoryConfig(config), config, teams, {
      now: () => now,
    });
    return { directory, advance: (ms: number) => (now += ms) };
  }

  it('is noticed by the next check, without a restart', async () => {
    const { directory, advance } = withClock();
    gh.installedOn = new Map();

    expect(await directory.probe()).toMatchObject({ level: 'fail' });

    // What the operator does next: install it, then press the check again
    gh.installedOn = new Map([['acme', 90001]]);
    advance(31_000);

    expect(await directory.probe()).toMatchObject({ level: 'ok' });
  });

  it('is noticed by a question asked after that check, not only by the check', async () => {
    const { directory, advance } = withClock();
    gh.installedOn = new Map();
    expect(await directory.groupSize('acme/platform')).toBeNull();

    gh.installedOn = new Map([['acme', 90001]]);
    advance(31_000);
    await directory.probe();

    expect(await directory.groupSize('acme/platform')).toBe(7);
  });

  it('does not re-ask GitHub for the installation list on every question', async () => {
    const directory = directoryFor(['acme/platform', 'acme/readers']);
    await directory.groupSize('acme/platform');
    await directory.groupSize('acme/readers');
    await directory.subjectExists(ADA);

    expect(gh.seen.filter((call) => call === 'GET /api/v3/app/installations')).toHaveLength(1);
  });
});

describe('an installation that is suspended', () => {
  it('is not counted as reaching the organisation', async () => {
    gh.suspended = ['acme'];

    expect(await detailOf(() => directoryFor().subjectExists(ADA))).toMatch(
      /not installed on "acme"/,
    );
  });
});

describe('an organisation no app is installed on', () => {
  const unreached = () => directoryFor(['nowhere/team']);

  it('answers an unknown team size', async () => {
    expect(await unreached().groupSize('nowhere/team')).toBeNull();
  });

  it('is unavailable, and says what to install', async () => {
    expect(await detailOf(() => unreached().subjectExists(ADA))).toMatch(
      /not installed on "nowhere"/,
    );
  });

  it('is skipped rather than answering for an organisation that does work', async () => {
    expect(await directoryFor(['nowhere/team', 'acme/platform']).subjectExists(ADA)).toBe(true);
  });
});

/** The reason and detail of the unavailability a call reports */
async function detailOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof DirectoryUnavailableError) return `${err.reason} ${err.detail}`;
    throw err;
  }
  throw new Error('expected the directory to report itself unavailable');
}

describe('the memoised lookup', () => {
  it('is rebuilt when a group source names a different organisation', () => {
    const config = configFor(['acme/platform']);
    const first = createDirectoryLookup(config);

    config.adopt(loadInstanceConfig(instanceYaml(['other/people'])));
    const second = createDirectoryLookup(config);

    // The org set is derived from the group sources, so it is part of what this
    // directory *is* -- a memo that ignored it would keep asking the old org
    expect(second).not.toBe(first);
  });

  it.each([
    ['App id', (yaml: string) => yaml.replace(`app_id: '2'`, `app_id: '3'`)],
    ['private key', (yaml: string) => yaml.replace('${TEST_APP_KEY}', '${TEST_OTHER_APP_KEY}')],
    ['GitHub host', (yaml: string) => yaml.replace(gh.base, 'https://ghe.acme.test')],
  ])('is rebuilt when the %s changes', (_what, change) => {
    const config = configFor(['acme/platform']);
    const first = createDirectoryLookup(config);

    config.adopt(loadInstanceConfig(change(instanceYaml(['acme/platform']))));

    // A memo that ignored the credentials would keep minting tokens as the old App
    expect(createDirectoryLookup(config)).not.toBe(first);
  });

  it('is still a memo when nothing about it changed', () => {
    const config = configFor(['acme/platform']);

    expect(createDirectoryLookup(config)).toBe(createDirectoryLookup(config));
  });
});

describe('the groups on a session', () => {
  /*
    Each case asks for its own `cache_ttl`. That is not decoration: `refreshGroupIds`
    goes through the memoised lookup, so configurations with the same fingerprint
    share one directory instance -- and one answer cache along with it. A distinct
    TTL is the honest way to ask for a fresh one, since the TTL is what these are
    about anyway.
  */
  async function signedIn(options: {
    groups: string[];
    fetchedAgo: number;
    cacheTtl: string;
    teams?: string[];
    directory?: boolean;
  }) {
    const token = mintToken();
    const row = await Session.create({
      tenant_id: harness.tenantId,
      token_hash: hashToken(token),
      provider: 'hub',
      subject: ADA,
      email: null,
      raw_group_ids: options.groups,
      groups_fetched_at: new Date(Date.now() - options.fetchedAgo),
      expires_at: new Date(Date.now() + 3_600_000),
    });

    let yaml = instanceYaml(options.teams, options.cacheTtl);
    if (options.directory === false) {
      yaml = yaml.replace(
        `      directory:\n        type: github\n        app_id: '2'\n` +
          `        private_key: \${TEST_APP_KEY}\n        cache_ttl: ${options.cacheTtl}\n`,
        '',
      );
    }
    const sessions = new SessionService(new ConfigService(loadInstanceConfig(yaml)));

    return {
      read: () => sessions.read({ cookies: { [SESSION_COOKIE]: token } } as never),
      stored: async () => (await Session.findByPk(row.id))!,
    };
  }

  it('are re-read once the snapshot is older than the directory says', async () => {
    gh.teamMembers = new Map([['acme/platform', ['ada']]]);
    const session = await signedIn({
      groups: ['acme/readers'],
      fetchedAgo: 2 * 3_600_000,
      cacheTtl: '1h',
      teams: ['acme/platform', 'acme/readers'],
    });

    expect((await session.read())?.rawGroupIds).toEqual(['acme/platform']);
  });

  it('are written back, so the next request does not ask again', async () => {
    const before = Date.now();
    const session = await signedIn({
      groups: ['acme/readers'],
      fetchedAgo: 2 * 3_600_000,
      cacheTtl: '55m',
      teams: ['acme/platform'],
    });

    await session.read();
    const stored = await session.stored();

    expect(stored.raw_group_ids).toEqual(['acme/platform']);
    expect(stored.groups_fetched_at!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('lose a team the person has been taken out of', async () => {
    gh.teamMembers = new Map();
    const session = await signedIn({
      groups: ['acme/platform'],
      fetchedAgo: 2 * 3_600_000,
      cacheTtl: '50m',
    });

    expect((await session.read())?.rawGroupIds).toEqual([]);
  });

  it('cost nothing while the snapshot is still inside the window', async () => {
    const session = await signedIn({
      groups: ['acme/platform'],
      fetchedAgo: 60_000,
      cacheTtl: '2h',
    });

    expect((await session.read())?.rawGroupIds).toEqual(['acme/platform']);
    expect(gh.seen).toEqual([]);
    expect((await session.stored()).groups_fetched_at!.getTime()).toBeLessThan(Date.now() - 30_000);
  });

  it('stand when the directory cannot be reached, rather than locking somebody out', async () => {
    gh.failOrgReads = 403;
    const session = await signedIn({
      groups: ['acme/platform'],
      fetchedAgo: 4 * 3_600_000,
      cacheTtl: '3h',
    });

    expect((await session.read())?.rawGroupIds).toEqual(['acme/platform']);
  });

  it('are never re-read for a provider with no directory to ask', async () => {
    const session = await signedIn({
      groups: ['acme/readers'],
      fetchedAgo: 9 * 3_600_000,
      cacheTtl: '45m',
      directory: false,
    });

    expect((await session.read())?.rawGroupIds).toEqual(['acme/readers']);
    expect(gh.seen).toEqual([]);
  });

  it('are read past the directory cache once a webhook marked them stale', async () => {
    gh.teamMembers = new Map([['acme/platform', ['ada']]]);
    const session = await signedIn({ groups: [], fetchedAgo: 2 * 3_600_000, cacheTtl: '40m' });
    expect((await session.read())?.rawGroupIds).toEqual(['acme/platform']);

    gh.teamMembers = new Map();
    await Session.update(
      { groups_fetched_at: null },
      { where: { id: (await session.stored()).id } },
    );

    expect((await session.read())?.rawGroupIds).toEqual([]);
  });
});

describe('a delivery from the directory App', () => {
  const SECRET = 'directory-secret';

  function controllerFor(secret: string | null): DirectoryWebhookController {
    const yaml = instanceYaml(['acme/platform'], '1h').replace(
      '        cache_ttl: 1h',
      secret === null
        ? '        cache_ttl: 1h'
        : `        cache_ttl: 1h\n        webhook_secret: ${secret}`,
    );
    const tenancy = { resolveTenant: async () => ({ id: harness.tenantId, slug: 'test' }) };
    return new DirectoryWebhookController(
      new ConfigService(loadInstanceConfig(yaml)),
      tenancy as unknown as TenancyService,
    );
  }

  async function deliver(
    controller: DirectoryWebhookController,
    event: string,
    payload: unknown,
    options: { secret?: string; provider?: string } = {},
  ): Promise<number> {
    const body = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', options.secret ?? SECRET)
      .update(body)
      .digest('hex');
    let status = 0;
    const res = {
      status: (code: number) => {
        status = code;
        return { end: () => undefined };
      },
    };
    await controller.receive(options.provider ?? 'hub', { rawBody: body } as never, res as never, {
      'x-github-event': event,
      'x-hub-signature-256': `sha256=${signature}`,
    });
    return status;
  }

  async function sessionFor(subject: string): Promise<string> {
    const row = await Session.create({
      tenant_id: harness.tenantId,
      token_hash: hashToken(mintToken()),
      provider: 'hub',
      subject,
      email: null,
      raw_group_ids: ['acme/platform'],
      groups_fetched_at: new Date(),
      expires_at: new Date(Date.now() + 3_600_000),
    });
    return row.id;
  }

  const fetchedAt = async (id: string) => (await Session.findByPk(id))!.groups_fetched_at;

  it("marks only the named person's groups stale when their membership changes", async () => {
    const ada = await sessionFor(ADA);
    const other = await sessionFor('8812');

    const status = await deliver(controllerFor(SECRET), 'membership', {
      action: 'removed',
      member: { id: Number(ADA), login: 'ada' },
    });

    expect(status).toBe(202);
    expect(await fetchedAt(ada)).toBeNull();
    expect(await fetchedAt(other)).not.toBeNull();
  });

  it('marks everybody on the provider stale when a team changes', async () => {
    const ada = await sessionFor(ADA);
    const other = await sessionFor('8813');

    expect(await deliver(controllerFor(SECRET), 'team', { action: 'deleted' })).toBe(202);
    expect(await fetchedAt(ada)).toBeNull();
    expect(await fetchedAt(other)).toBeNull();
  });

  it('refuses a delivery signed with another secret, and changes nothing', async () => {
    const ada = await sessionFor(ADA);
    const status = await deliver(controllerFor(SECRET), 'team', {}, { secret: 'guessed' });

    expect(status).toBe(401);
    expect(await fetchedAt(ada)).not.toBeNull();
  });

  it('refuses every delivery when the directory has no secret', async () => {
    expect(await deliver(controllerFor(null), 'team', {}, { secret: '' })).toBe(401);
  });

  it('is not found for a provider without a GitHub directory', async () => {
    expect(await deliver(controllerFor(SECRET), 'team', {}, { provider: 'nobody' })).toBe(404);
  });
});

interface FakeGithub {
  base: string;
  seen: string[];
  appJwts: string[];
  /** Logins that are active members, by org */
  memberships: Map<string, string[]>;
  /** Logins that are members of `org/team-slug` */
  teamMembers: Map<string, string[]>;
  /** Teams whose membership is invited but not accepted */
  pending: string[];
  /** Organisations the directory App is installed on, with the installation id */
  installedOn: Map<string, number>;
  /** Organisations whose installation is suspended */
  suspended: string[];
  teams: Map<string, number>;
  logins: Map<string, string>;
  failOrgReads: number | null;
  /** Refuses team reads only, as an App without Members: Read-only does */
  failTeamReads: number | null;
  reset(): void;
  stop(): Promise<void>;
}

async function startFakeGithub(): Promise<FakeGithub> {
  const { privateKey } = await generateKeyPair('RS256');
  process.env.TEST_APP_KEY = await exportPKCS8(privateKey);
  process.env.TEST_OTHER_APP_KEY = await exportPKCS8((await generateKeyPair('RS256')).privateKey);

  const state: FakeGithub = {
    base: '',
    seen: [],
    appJwts: [],
    memberships: new Map(),
    teamMembers: new Map(),
    pending: [],
    installedOn: new Map(),
    suspended: [],
    teams: new Map(),
    logins: new Map(),
    failOrgReads: null,
    failTeamReads: null,
    reset() {
      state.seen = [];
      state.appJwts = [];
      state.memberships = new Map([['acme', ['ada']]]);
      state.teamMembers = new Map([
        ['acme/platform', ['ada']],
        ['acme/readers', ['ada']],
      ]);
      state.pending = [];
      state.installedOn = new Map([['acme', 90001]]);
      state.suspended = [];
      state.teams = new Map([['acme/platform', 7]]);
      state.logins = new Map([[ADA, 'ada']]);
      state.failOrgReads = null;
      state.failTeamReads = null;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  state.reset();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', state.base);
      const path = url.pathname;
      state.seen.push(`${req.method} ${path}`);

      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');

      // Both app-level routes are reached with an app JWT, not an installation token
      if (req.method === 'GET' && path === '/api/v3/app/installations') {
        state.appJwts.push(token);
        return send(
          res,
          200,
          [...state.installedOn].map(([login, id]) => ({
            id,
            account: { login },
            suspended_at: state.suspended.includes(login) ? new Date().toISOString() : null,
          })),
        );
      }

      const minting = /^\/api\/v3\/app\/installations\/([^/]+)\/access_tokens$/.exec(path);
      if (req.method === 'POST' && minting) {
        state.appJwts.push(token);
        return send(res, 201, {
          token: `inst-${minting[1]}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }

      if (!token.startsWith('inst-')) return send(res, 401, { message: 'not an installation' });
      if (state.failOrgReads) return send(res, state.failOrgReads, { message: 'no' });

      const user = /^\/api\/v3\/user\/([^/]+)$/.exec(path);
      if (user) {
        const login = state.logins.get(user[1]);
        return login ? send(res, 200, { id: Number(user[1]), login }) : send(res, 404, {});
      }

      const teamMember = /^\/api\/v3\/orgs\/([^/]+)\/teams\/([^/]+)\/memberships\/([^/]+)$/.exec(
        path,
      );
      if (teamMember) {
        const id = `${teamMember[1]}/${teamMember[2]}`;
        const members = state.teamMembers.get(id) ?? [];
        if (!members.includes(teamMember[3])) return send(res, 404, {});
        return send(res, 200, { state: state.pending.includes(id) ? 'pending' : 'active' });
      }

      const team = /^\/api\/v3\/orgs\/([^/]+)\/teams\/([^/]+)$/.exec(path);
      if (team) {
        if (state.failTeamReads) return send(res, state.failTeamReads, { message: 'no' });
        const count = state.teams.get(`${team[1]}/${team[2]}`);
        return count === undefined
          ? send(res, 404, {})
          : send(res, 200, { slug: team[2], members_count: count });
      }

      const membership = /^\/api\/v3\/orgs\/([^/]+)\/memberships\/([^/]+)$/.exec(path);
      if (membership) {
        const members = state.memberships.get(membership[1]) ?? [];
        return members.includes(membership[2])
          ? send(res, 200, { state: 'active', role: 'member' })
          : send(res, 404, {});
      }

      const org = /^\/api\/v3\/orgs\/([^/]+)$/.exec(path);
      if (org) return send(res, 200, { login: org[1] });

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

export type { IncomingMessage };
