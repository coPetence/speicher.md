import { readFileSync } from 'node:fs';

import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import request from 'supertest';

import { ConfigService } from '../../src/config/config.service';
import {
  CONFIG_SOURCE_ENV,
  INSTANCE_CONFIG_PATH_ENV,
  appendConfigVersion,
  getNewestConfigVersion,
  loadActiveInstanceConfig,
} from '../../src/config/loader';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let harness: Harness;
let config: ConfigService;
let app: INestApplication;
let ops: string;

const ORIGINAL_SOURCE = process.env[CONFIG_SOURCE_ENV];
const CONFIG_PATH = process.env[INSTANCE_CONFIG_PATH_ENV] as string;
const FIXTURE_YAML = readFileSync(CONFIG_PATH, 'utf8');

beforeAll(async () => {
  harness = await createHarness();
  ops = await sessionCookieFor(harness.tenantId, 'ops');
  process.env[CONFIG_SOURCE_ENV] = 'database';
  await reset();
  config = new ConfigService(await loadActiveInstanceConfig());
  app = await bootTestApp(config);
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
  await getSequelize().query(`DELETE FROM instance_state`, { type: QueryTypes.DELETE });
  const seeded = await loadActiveInstanceConfig();
  if (config) config.adopt(seeded);
}

async function store(yaml: string, appliedBy = 'ops@copetence.test'): Promise<void> {
  await appendConfigVersion(harness.tenantId, {
    yaml,
    resolutionHash: 'x',
    origin: 'admin',
    appliedBy,
  });
}

async function versionCount(): Promise<number> {
  const rows = await getSequelize().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM instance_configs WHERE tenant_id = :tenantId`,
    { type: QueryTypes.SELECT, replacements: { tenantId: harness.tenantId } },
  );
  return Number(rows[0].count);
}

const history = (query = '') =>
  request(app.getHttpServer()).get(`/-/config/history${query}`).set('cookie', ops);

const restore = (version: unknown) =>
  request(app.getHttpServer()).post('/-/config/restore').set('cookie', ops).send({ version });

describe('who can reach it', () => {
  it('404s for a maintainer and for an anonymous caller', async () => {
    const alice = await sessionCookieFor(harness.tenantId, 'alice');
    await request(app.getHttpServer()).get('/-/config/history').set('cookie', alice).expect(404);
    await request(app.getHttpServer()).get('/-/config/history').expect(404);
    await request(app.getHttpServer())
      .post('/-/config/restore')
      .set('cookie', alice)
      .send({ version: 1 })
      .expect(404);
    expect(await versionCount()).toBe(1);
  });
});

describe('the list', () => {
  it('says who applied each version and when', async () => {
    await store(`${FIXTURE_YAML}\ntheme:\n  template: editorial\n`, 'ops@copetence.test');

    const json = await history().set('accept', 'application/json').expect(200);
    expect(json.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(json.body.versions[0].applied_by).toBe('ops@copetence.test');
    expect(json.body.versions[0].applied_at).toBeTruthy();
    expect(json.body.versions[1].applied_by).toBeNull();
    expect(json.body.versions[1].origin).toBe('file');
  });

  it('marks the version this process is running', async () => {
    await store(`${FIXTURE_YAML}\ntheme:\n  template: editorial\n`);
    const json = await history().set('accept', 'application/json').expect(200);
    expect(json.body.running_version).toBe(1);
    expect(json.body.versions.find((v: { version: number }) => v.version === 1).running).toBe(true);
    expect(json.body.versions.find((v: { version: number }) => v.version === 2).running).toBe(
      false,
    );
  });
});

describe('the difference between two versions', () => {
  it('defaults to the most recent change', async () => {
    await store(`${FIXTURE_YAML}\ntheme:\n  template: editorial\n`);
    const json = await history().set('accept', 'application/json').expect(200);
    expect(json.body.from).toBe(1);
    expect(json.body.to).toBe(2);
  });

  it('shows the lines that changed and leaves the rest out of the way', async () => {
    await store(FIXTURE_YAML.replace('subject_claim: oid', 'subject_claim: sub'));
    const page = await history('?from=1&to=2').expect(200);

    expect(page.text).toContain('- ' + '      subject_claim: oid');
    expect(page.text).toContain('+ ' + '      subject_claim: sub');
    expect(page.text).toContain('unchanged lines');
  });

  it('counts what moved', async () => {
    await store(`${FIXTURE_YAML}\ntheme:\n  template: editorial\n`);
    const json = await history('?from=1&to=2').set('accept', 'application/json').expect(200);
    expect(json.body.diff.added).toBe(3);
    expect(json.body.diff.removed).toBe(0);
    expect(json.body.diff.identical).toBe(false);
  });

  it('says so when two versions are the same', async () => {
    await store(FIXTURE_YAML);
    const json = await history('?from=1&to=2').set('accept', 'application/json').expect(200);
    expect(json.body.diff.identical).toBe(true);
  });

  it('selects a version from the list, and compares it with the one before it', async () => {
    await store(`${FIXTURE_YAML}\nattribution: false\n`);
    await store(`${FIXTURE_YAML}\ntheme:\n  template: editorial\n`);

    const json = await history('?to=2').set('accept', 'application/json').expect(200);
    expect(json.body.from).toBe(1);
    expect(json.body.to).toBe(2);

    const page = await history('?to=2').expect(200);
    expect(page.text).toContain('href="/-/config/history?to=2" aria-current="true"');
    expect(page.text).not.toContain('href="/-/config/history?to=3" aria-current');
    expect(page.text).toMatch(/<select\s+id="diff-from"[\s\S]*?value="1"\s+selected/);
    expect(page.text).toMatch(/<select\s+id="diff-to"[\s\S]*?value="2"\s+selected/);
    expect(page.text).toMatch(
      /<div class="spr-history-bar">[\s\S]*?data-spr-compare[\s\S]*?<svg class="spr-icon"[\s\S]*?Restore version 2[\s\S]*?<\/div>/,
    );
    expect(page.text).not.toContain('Restore version 1');
    expect(page.text).toContain(
      '<form class="spr-form" method="get" action="/-/config/history" data-spr-compare>',
    );
    expect(page.text).toContain('type="module"');
    expect(page.text).toContain('<button type="submit">Show the difference</button>');
    const list = /<nav class="spr-versions"[\s\S]*?<\/nav>/.exec(page.text)?.[0] ?? '';
    expect(list).toContain('#2');
    expect(list).toContain('ago</time>');
    expect(list).not.toContain('<code>');
    expect(page.text).not.toContain('to version');
    expect(page.text).not.toMatch(/lines? added/);

    const oldest = await history('?to=1').set('accept', 'application/json').expect(200);
    expect(oldest.body.from).toBe(1);
    expect(oldest.body.diff.identical).toBe(true);
  });

  it('compares any two, not only neighbours', async () => {
    await store(`${FIXTURE_YAML}\nattribution: false\n`);
    await store(`${FIXTURE_YAML}\ntheme:\n  template: editorial\n`);
    const json = await history('?from=1&to=3').set('accept', 'application/json').expect(200);
    expect(json.body.from).toBe(1);
    expect(json.body.to).toBe(3);
    expect(json.body.diff.identical).toBe(false);
  });
});

describe('a secret stored as a literal', () => {
  const withLiteral = (value: string) =>
    FIXTURE_YAML.replace('client_secret: ${TEST_ENTRA_CLIENT_SECRET}', `client_secret: ${value}`);

  it('never reaches the diff', async () => {
    await store(withLiteral('the-old-secret'));
    await store(withLiteral('the-new-secret'));

    const page = await history('?from=2&to=3').expect(200);
    expect(page.text).not.toContain('the-old-secret');
    expect(page.text).not.toContain('the-new-secret');
  });

  it('is still reported as having changed, by path and not by value', async () => {
    await store(withLiteral('the-old-secret'));
    await store(withLiteral('the-new-secret'));

    const json = await history('?from=2&to=3').set('accept', 'application/json').expect(200);
    expect(json.body.diff.hiddenChanges).toEqual(['auth.providers.entra.client_secret']);

    const page = await history('?from=2&to=3').expect(200);
    expect(page.text).toContain('A stored value changed that is not shown');
    expect(page.text).toContain('auth.providers.entra.client_secret');
  });

  it('reports nothing hidden when the reference itself changed, since that is visible', async () => {
    await store(FIXTURE_YAML.replace('${TEST_ENTRA_CLIENT_SECRET}', '${TEST_GH_WEBHOOK_SECRET}'));
    const json = await history('?from=1&to=2').set('accept', 'application/json').expect(200);
    expect(json.body.diff.hiddenChanges).toEqual([]);
    expect((await history('?from=1&to=2')).text).toContain('TEST_GH_WEBHOOK_SECRET');
  });
});

describe('rollback', () => {
  it('appends a version rather than removing any', async () => {
    await store(`${FIXTURE_YAML}\ntheme:\n  template: editorial\n`);
    expect(await versionCount()).toBe(2);

    await restore(1).expect(303);

    expect(await versionCount()).toBe(3);
    const newest = await getNewestConfigVersion(harness.tenantId);
    expect(newest?.version).toBe(3);
    expect(newest?.yaml).toBe(FIXTURE_YAML);
    expect(newest?.applied_by).toBe('ops@copetence.test');

    const [row] = await getSequelize().query<{ yaml: string }>(
      `SELECT yaml FROM instance_configs WHERE tenant_id = :tenantId AND version = 2`,
      { type: QueryTypes.SELECT, replacements: { tenantId: harness.tenantId } },
    );
    expect(row.yaml).toContain('template: editorial');
  });

  it('takes effect without a restart when it can', async () => {
    await store(`${FIXTURE_YAML}\nattribution: false\n`);
    const json2 = await restore(2).set('accept', 'application/json').expect(200);
    expect(json2.body.saved).toBe(3);
    expect(config.attribution).toBe(false);

    await restore(1).expect(303);
    expect(config.attribution).toBe(true);
  });

  it('refuses a version that would not load today', async () => {
    await store(FIXTURE_YAML.replace('${TEST_ENTRA_CLIENT_SECRET}', '${SPEICHER_TEST_NEVER_SET}'));

    const page = await restore(2).expect(409);
    expect(page.text).toContain('SPEICHER_TEST_NEVER_SET');
    expect(await versionCount()).toBe(2);
    expect(config.configVersion).toBe(1);
  });

  it('404s for a version that does not exist', async () => {
    await restore(99).expect(404);
    await restore('not a number').expect(404);
    expect(await versionCount()).toBe(1);
  });

  it('is refused while the file is authoritative', async () => {
    process.env[CONFIG_SOURCE_ENV] = 'file';
    try {
      const page = await restore(1).expect(409);
      expect(page.text).toContain('file-authoritative');
      expect(await versionCount()).toBe(1);
    } finally {
      process.env[CONFIG_SOURCE_ENV] = 'database';
    }
  });
});
