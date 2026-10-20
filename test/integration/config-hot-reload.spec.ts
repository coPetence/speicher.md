import { readFileSync } from 'node:fs';

import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import request from 'supertest';

import { HOT_RELOAD_AVAILABLE } from '../../src/config/classification';
import { ConfigService } from '../../src/config/config.service';
import {
  CONFIG_SOURCE_ENV,
  INSTANCE_CONFIG_PATH_ENV,
  appendConfigVersion,
  loadActiveInstanceConfig,
} from '../../src/config/loader';
import { ConfigWatcher } from '../../src/config/watcher';
import { Forge, initModels } from '../../src/db/models';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { JobQueue } from '../../src/jobs/queue';
import { Worker } from '../../src/jobs/worker';
import { Mailer } from '../../src/notify/mailer';
import { RESOLUTION_HASH_KEY, checkResolutionHash } from '../../src/config/resolution-guard';
import { unclaimedInstanceConfig } from '../../src/dashboard/setup/unclaimed';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';
import { startSmtpSink } from '../helpers/smtp-sink';

let harness: Harness;
let config: ConfigService;
let watcher: ConfigWatcher;
let app: INestApplication;
let alice: string;

const ORIGINAL_SOURCE = process.env[CONFIG_SOURCE_ENV];
const CONFIG_PATH = process.env[INSTANCE_CONFIG_PATH_ENV] as string;
const FIXTURE_YAML = readFileSync(CONFIG_PATH, 'utf8');

beforeAll(async () => {
  harness = await createHarness();
  initModels();
  alice = await sessionCookieFor(harness.tenantId, 'alice');
  process.env[CONFIG_SOURCE_ENV] = 'database';
  await reset();
  config = new ConfigService(await loadActiveInstanceConfig());
  app = await bootTestApp(config);
  watcher = app.get(ConfigWatcher);
});

beforeEach(async () => {
  process.env[CONFIG_SOURCE_ENV] = 'database';
  await reset();
});

afterAll(async () => {
  await app?.close();
  if (ORIGINAL_SOURCE === undefined) delete process.env[CONFIG_SOURCE_ENV];
  else process.env[CONFIG_SOURCE_ENV] = ORIGINAL_SOURCE;
  await harness?.close();
  await closeSequelize();
});

async function reset(): Promise<void> {
  await getSequelize().query(`DELETE FROM instance_configs`, { type: QueryTypes.DELETE });
  await getSequelize().query(`DELETE FROM jobs`, { type: QueryTypes.DELETE });
  await getSequelize().query(`DELETE FROM instance_state`, { type: QueryTypes.DELETE });

  const seeded = await loadActiveInstanceConfig();
  if (!config) return;
  config.adopt(seeded);
  await checkResolutionHash(config);
}

async function store(yaml: string): Promise<void> {
  await appendConfigVersion(harness.tenantId, {
    yaml,
    resolutionHash: 'not-read-by-the-watcher',
    origin: 'admin',
    appliedBy: 'ops@copetence.test',
  });
}

const readerPage = () =>
  request(app.getHttpServer()).get('/handbook/introduction').set('cookie', alice);

async function rebuildJobs(): Promise<number> {
  const rows = await getSequelize().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM jobs WHERE kind = 'rebuild'`,
    { type: QueryTypes.SELECT },
  );
  return Number(rows[0].count);
}

it('is switched on, or none of the rest of this means anything', () => {
  expect(HOT_RELOAD_AVAILABLE).toBe(true);
});

describe('a version that can be applied per request', () => {
  it('changes what the next request renders, with no restart', async () => {
    expect((await readerPage().expect(200)).text).toContain('speicher.md');

    await store(`${FIXTURE_YAML}\nattribution: false\n`);
    expect((await watcher.refresh()).adopted).toBe(true);

    expect((await readerPage().expect(200)).text).not.toContain('Published with');
    expect(config.configVersion).toBe(2);
  });

  it('removes a whole surface, not just a value', async () => {
    await store(`${FIXTURE_YAML}\ngraph:\n  related: false\n`);
    await watcher.refresh();

    expect((await readerPage().expect(200)).text).not.toContain('spr-related');
  });

  it('is idempotent: a second look adopts nothing', async () => {
    await store(`${FIXTURE_YAML}\nattribution: false\n`);
    expect((await watcher.refresh()).adopted).toBe(true);
    expect((await watcher.refresh()).adopted).toBe(false);
    expect(config.configVersion).toBe(2);
  });
});

describe('a version that builds something at startup', () => {
  it('is not adopted, and neither is the rest of it', async () => {
    await store(
      `${FIXTURE_YAML}\nattribution: false\nassets:\n  driver: filesystem\n  path: ./var/assets-elsewhere\n`,
    );

    const result = await watcher.refresh();
    expect(result.adopted).toBe(false);
    expect(result.waiting).toEqual(['assets']);

    expect((await readerPage().expect(200)).text).toContain('speicher.md');
    expect(config.configVersion).toBe(1);
  });
});

describe('a version that adds a forge', () => {
  const SECOND_FORGE = [
    '  partner:',
    '    type: github',
    '    default_repository_owner: partners',
    '    base_url: http://127.0.0.1:1',
    '    app_id: "424242"',
    '    private_key: ${TEST_GH_PRIVATE_KEY}',
    '    webhook_secret: partner-secret',
    '',
  ].join('\n');

  const ANCHOR = '    webhook_secret: ${TEST_GH_WEBHOOK_SECRET}\n';

  function withPartner(): string {
    expect(FIXTURE_YAML).toContain(ANCHOR);
    return FIXTURE_YAML.replace(ANCHOR, ANCHOR + SECOND_FORGE);
  }

  const deliverToPartner = () =>
    request(app.getHttpServer())
      .post('/-/hooks/forge/partner')
      .set('content-type', 'application/json')
      .set('x-github-event', 'push')
      .send('{}');

  const partnerRow = () =>
    Forge.findOne({ where: { tenant_id: harness.tenantId, key: 'partner' } });

  async function clearDiscoverJobs(): Promise<void> {
    await getSequelize().query(`DELETE FROM jobs WHERE kind = 'sync-repo-list'`, {
      type: QueryTypes.DELETE,
    });
  }

  it('builds a driver for a forge this process did not boot with', async () => {
    await deliverToPartner().expect(404);

    await store(withPartner());
    const result = await watcher.refresh();
    expect(result.adopted).toBe(true);
    expect(result.waiting).toEqual([]);

    await deliverToPartner().expect(401);
  });

  it('gives that forge its `forges` row when discovery asks, not at a restart', async () => {
    await store(withPartner());
    expect((await watcher.refresh()).adopted).toBe(true);
    expect(await partnerRow()).toBeNull();

    const queue = app.get(JobQueue);
    await queue.enqueue({
      tenantId: harness.tenantId,
      kind: 'sync-repo-list',
      payload: { forgeKey: 'partner' },
      dedupeKey: 'sync-repo-list:partner',
    });
    const [job] = (await queue.claim(10)).filter((row) => row.kind === 'sync-repo-list');
    expect(job).toBeDefined();
    await (app.get(Worker) as unknown as { run(row: typeof job): Promise<void> }).run(job);

    expect((await partnerRow())?.type).toBe('github');
  });

  it('is asked what it holds on the next tick, not on the discovery interval', async () => {
    await store(withPartner());
    expect((await watcher.refresh()).adopted).toBe(true);
    await clearDiscoverJobs();

    const worker = app.get(Worker);
    (worker as unknown as { running: boolean }).running = true;
    try {
      await worker.reconcile();
    } finally {
      (worker as unknown as { running: boolean }).running = false;
    }

    const [row] = await getSequelize().query<{ run_after: Date }>(
      `SELECT run_after FROM jobs
        WHERE tenant_id = :tenantId AND kind = 'sync-repo-list' AND dedupe_key = 'sync-repo-list:partner'`,
      { type: QueryTypes.SELECT, replacements: { tenantId: harness.tenantId } },
    );
    expect(row).toBeDefined();
    expect(new Date(row.run_after).getTime()).toBeLessThan(Date.now() + 60_000);
  });
});

describe('a version that repoints the mail relay', () => {
  const mailAt = (port: number) =>
    `${FIXTURE_YAML}\nmail:\n  host: 127.0.0.1\n  port: ${port}\n  from: Docs <docs@example.test>\n`;

  it('is adopted, and the next message goes to the new relay', async () => {
    const first = await startSmtpSink();
    const second = await startSmtpSink();
    try {
      await store(mailAt(first.port));
      expect((await watcher.refresh()).adopted).toBe(true);

      const mailer = app.get(Mailer);
      await mailer.send('reader@example.test', 'first', 'a link, not a detail');
      expect(mailer.health.lastError).toBeNull();
      expect(first.messages).toHaveLength(1);
      expect(first.messages[0]).toContain('Subject: first');

      await store(mailAt(second.port));
      expect((await watcher.refresh()).adopted).toBe(true);

      await mailer.send('reader@example.test', 'second', 'a link, not a detail');
      expect(mailer.health.lastError).toBeNull();
      expect(second.messages).toHaveLength(1);
      expect(second.messages[0]).toContain('Subject: second');
      expect(first.messages).toHaveLength(1);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

describe('a version that changes the providers', () => {
  const SECOND_PROVIDER = [
    '    okta:',
    '      type: oidc',
    '      issuer: https://example.okta.test',
    '      client_id: "a-public-client"',
    '      display_name: Okta for partners',
    '',
  ].join('\n');

  const PROVIDER_ANCHOR = '      session_ttl: 8h\n';

  function withSecondProvider(): string {
    expect(FIXTURE_YAML).toContain(PROVIDER_ANCHOR);
    return FIXTURE_YAML.replace(PROVIDER_ANCHOR, PROVIDER_ANCHOR + SECOND_PROVIDER);
  }

  const renamedProvider = () =>
    FIXTURE_YAML.replace(/^ {4}entra:$/m, '    entraid:')
      .replace(/provider: entra,/g, 'provider: entraid,')
      .replace('default_provider: entra', 'default_provider: entraid');

  it('adopts it: `auth` builds nothing that outlives a request', async () => {
    await store(renamedProvider());

    const result = await watcher.refresh();
    expect(result.adopted).toBe(true);
    expect(result.waiting).toEqual([]);
    expect(config.provider('entraid')).toBeDefined();
    expect(config.provider('entra')).toBeUndefined();
  });

  it('takes the group sources naming it along, in the same step', async () => {
    await store(renamedProvider());
    expect((await watcher.refresh()).adopted).toBe(true);

    expect(config.instance.groups?.engineering?.[0].provider).toBe('entraid');
    expect(config.defaultProviderId).toBe('entraid');
  });

  it('offers a login through a provider this process did not boot with', async () => {
    const picker = () => request(app.getHttpServer()).get('/api/auth/login?provider=');

    expect((await picker().expect(200)).text).not.toContain('Okta for partners');

    await store(withSecondProvider());
    const result = await watcher.refresh();
    expect(result.adopted).toBe(true);
    expect(result.waiting).toEqual([]);

    expect((await picker().expect(200)).text).toContain('Sign in with Okta for partners');
  });

  it('rebuilds, because a grant naming it was a rejection until now', async () => {
    expect(await rebuildJobs()).toBe(0);

    await store(withSecondProvider());
    expect((await watcher.refresh()).adopted).toBe(true);

    expect(await rebuildJobs()).toBe(1);
  });

  it('leaves the sessions minted under the old name resolving into nothing', async () => {
    expect((await readerPage()).status).toBe(200);

    await store(renamedProvider());
    expect((await watcher.refresh()).adopted).toBe(true);

    expect((await readerPage()).status).toBe(404);
  });
});

describe('a version that changes how access resolves', () => {
  it('enqueues the rebuild itself, because the startup guard has already run', async () => {
    expect(await rebuildJobs()).toBe(0);

    await store(
      FIXTURE_YAML.replace(
        'groups:\n',
        "groups:\n  client-acme:\n    - { provider: entra, id: 'grp-acme' }\n",
      ),
    );

    expect((await watcher.refresh()).adopted).toBe(true);
    expect(await rebuildJobs()).toBe(1);

    const [row] = await getSequelize().query<{ value: string }>(
      `SELECT value #>> '{}' AS value FROM instance_state WHERE key = :key`,
      { type: QueryTypes.SELECT, replacements: { key: RESOLUTION_HASH_KEY } },
    );
    expect(row.value).toBe(config.resolutionHash);
  });

  it('enqueues nothing for a change outside the hash', async () => {
    await store(`${FIXTURE_YAML}\nattribution: false\n`);
    expect((await watcher.refresh()).adopted).toBe(true);
    expect(await rebuildJobs()).toBe(0);
  });
});

describe('an instance nobody has configured yet', () => {
  const MAIL_AND_MAGIC_LINK = `version: 1
mail:
  host: smtp.example.test
  port: 587
  from: docs@example.test
auth:
  providers:
    link:
      type: magic-link
      display_name: Email me a link
`;

  const PLUS_AN_OIDC_PROVIDER = `${MAIL_AND_MAGIC_LINK}    entra:
      type: oidc
      issuer: https://login.example.test/v2.0
      client_id: "a-client"
      display_name: Company sign-in
`;

  beforeEach(async () => {
    await getSequelize().query(`DELETE FROM instance_configs`, { type: QueryTypes.DELETE });
    config.adopt(unclaimedInstanceConfig());
    expect(config.configVersion).toBeNull();
    expect(config.providerShortIds).toEqual([]);
  });

  it('adopts what the wizard saves, one version after another', async () => {
    await store(MAIL_AND_MAGIC_LINK);
    const first = await watcher.refresh();
    expect(first.adopted).toBe(true);
    expect(first.waiting).toEqual([]);

    await store(PLUS_AN_OIDC_PROVIDER);
    const second = await watcher.refresh();
    expect(second.adopted).toBe(true);
    expect(second.waiting).toEqual([]);

    expect(config.instance.mail?.host).toBe('smtp.example.test');
    expect(config.providerShortIds.sort()).toEqual(['entra', 'link']);
  });

  it('offers both providers on the next request, with nothing restarted', async () => {
    await store(PLUS_AN_OIDC_PROVIDER);
    expect((await watcher.refresh()).adopted).toBe(true);

    const picker = await request(app.getHttpServer()).get('/api/auth/login?provider=').expect(200);
    expect(picker.text).toContain('Sign in with Company sign-in');
    expect(picker.text).toContain('action="/api/auth/discover"');
  });
});

describe('when the file is authoritative', () => {
  it('does not poll at all', async () => {
    process.env[CONFIG_SOURCE_ENV] = 'file';
    const fileConfig = new ConfigService({
      ...config.loadedConfig,
      source: 'file',
      version: null,
    });
    const idle = new ConfigWatcher(fileConfig);
    idle.onModuleInit();

    await store(`${FIXTURE_YAML}\nattribution: false\n`);
    expect((await idle.refresh()).adopted).toBe(false);
    expect(fileConfig.attribution).toBe(true);
    idle.onModuleDestroy();
  });
});
