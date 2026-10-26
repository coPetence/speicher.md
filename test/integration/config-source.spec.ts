import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import request from 'supertest';

import { ConfigError, ConfigReadOnlyError } from '../../src/common/errors';
import { ConfigService } from '../../src/config/config.service';
import {
  CONFIG_SOURCE_ENV,
  INSTANCE_CONFIG_PATH_ENV,
  appendConfigVersion,
  getNewestConfigVersion,
  loadActiveInstanceConfig,
  resolveConfigSource,
  saveInstanceConfig,
} from '../../src/config/loader';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import * as schemas from '../../src/config/schemas';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let harness: Harness;

const ORIGINAL_SOURCE = process.env[CONFIG_SOURCE_ENV];
const ORIGINAL_PATH = process.env[INSTANCE_CONFIG_PATH_ENV] as string;

const FIXTURE_YAML = readFileSync(ORIGINAL_PATH, 'utf8');

const ADMIN = { origin: 'admin', appliedBy: 'ops@copetence.test' } as const;
const ANONYMOUS_ADMIN = { origin: 'admin', appliedBy: null } as const;

beforeAll(async () => {
  harness = await createHarness();
});

afterEach(() => {
  if (ORIGINAL_SOURCE === undefined) delete process.env[CONFIG_SOURCE_ENV];
  else process.env[CONFIG_SOURCE_ENV] = ORIGINAL_SOURCE;
  process.env[INSTANCE_CONFIG_PATH_ENV] = ORIGINAL_PATH;
});

afterAll(async () => {
  await harness?.close();
  await closeSequelize();
});

async function rowCount(): Promise<number> {
  const rows = await getSequelize().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM instance_configs WHERE tenant_id = :tenantId`,
    { type: QueryTypes.SELECT, replacements: { tenantId: harness.tenantId } },
  );
  return Number(rows[0].count);
}

async function originValues(): Promise<string[]> {
  const rows = await getSequelize().query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'instance_configs'::regclass AND conname = 'instance_configs_origin'`,
    { type: QueryTypes.SELECT },
  );
  return [...(rows[0]?.def.match(/'[a-z]+'/g) ?? [])].map((v) => v.replace(/'/g, '')).sort();
}

async function clearVersions(): Promise<void> {
  await getSequelize().query(`DELETE FROM instance_configs`, { type: QueryTypes.DELETE });
}

describe('the instance_configs table', () => {
  it('accepts exactly the three origins a version can arrive by', async () => {
    expect(await originValues()).toEqual(['admin', 'file', 'setup']);
  });

  it('refuses a second row at the same version, which is what makes appends safe', async () => {
    await clearVersions();
    const first = await appendConfigVersion(harness.tenantId, {
      yaml: FIXTURE_YAML,
      resolutionHash: 'hash-1',
      origin: 'admin',
      appliedBy: 'ops@copetence.test',
    });
    expect(first?.version).toBe(1);

    await expect(
      getSequelize().query(
        `INSERT INTO instance_configs (tenant_id, version, yaml, resolution_hash, origin)
         VALUES (:tenantId, 1, 'x', 'y', 'admin')`,
        { type: QueryTypes.INSERT, replacements: { tenantId: harness.tenantId } },
      ),
    ).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
  });

  it('rejects an origin it has never heard of', async () => {
    await expect(
      getSequelize().query(
        `INSERT INTO instance_configs (tenant_id, version, yaml, resolution_hash, origin)
         VALUES (:tenantId, 99, 'x', 'y', 'somewhere-else')`,
        { type: QueryTypes.INSERT, replacements: { tenantId: harness.tenantId } },
      ),
    ).rejects.toThrow(/instance_configs_origin/);
  });
});

describe('choosing a source', () => {
  it('defaults to the file, so an instance that never heard of the variable is unaffected', () => {
    delete process.env[CONFIG_SOURCE_ENV];
    expect(resolveConfigSource()).toBe('file');
    process.env[CONFIG_SOURCE_ENV] = '';
    expect(resolveConfigSource()).toBe('file');
  });

  it('refuses a value it does not recognise rather than falling back', () => {
    process.env[CONFIG_SOURCE_ENV] = 'postgres';
    expect(() => resolveConfigSource()).toThrow(/must be "file" or "database"/);
  });
});

describe('file mode', () => {
  it('loads from the file and writes nothing to the table', async () => {
    process.env[CONFIG_SOURCE_ENV] = 'file';
    await clearVersions();

    const loaded = await loadActiveInstanceConfig();
    expect(loaded.source).toBe('file');
    expect(loaded.sourcePath).toBe(ORIGINAL_PATH);
    expect(loaded.version).toBeNull();
    expect(loaded.resolutionHash).toBe(loadInstanceConfigFromFile(ORIGINAL_PATH).resolutionHash);
    expect(await rowCount()).toBe(0);
  });

  it('refuses a save rather than accepting one that would never be read', async () => {
    process.env[CONFIG_SOURCE_ENV] = 'file';
    await clearVersions();

    await expect(saveInstanceConfig(harness.tenantId, FIXTURE_YAML, ADMIN)).rejects.toBeInstanceOf(
      ConfigReadOnlyError,
    );
    expect(await rowCount()).toBe(0);
  });
});

describe('database mode', () => {
  beforeEach(async () => {
    process.env[CONFIG_SOURCE_ENV] = 'database';
    await clearVersions();
  });

  it('seeds version 1 from the existing file, recording that it came from there', async () => {
    const loaded = await loadActiveInstanceConfig();

    const row = await getNewestConfigVersion(harness.tenantId);
    expect(row?.version).toBe(1);
    expect(row?.origin).toBe('file');
    expect(row?.applied_by).toBeNull();
    expect(row?.yaml).toBe(FIXTURE_YAML);
    expect(row?.yaml).toContain('${TEST_ENTRA_CLIENT_ID}');

    const fromFile = loadInstanceConfigFromFile(ORIGINAL_PATH);
    expect(loaded.resolutionHash).toBe(fromFile.resolutionHash);
    expect(loaded.raw).toEqual(fromFile.raw);
    expect(loaded.source).toBe('database');
    expect(loaded.version).toBe(1);
  });

  it('seeds once, not once per boot', async () => {
    await loadActiveInstanceConfig();
    await loadActiveInstanceConfig();
    expect(await rowCount()).toBe(1);
  });

  it('appends rather than updating, and boot then loads the newest', async () => {
    await loadActiveInstanceConfig();

    const edited = `${FIXTURE_YAML}\ntheme:\n  template: slate\n`;
    const saved = await saveInstanceConfig(harness.tenantId, edited, ADMIN);

    expect(saved.version).toBe(2);
    expect(saved.origin).toBe('admin');
    expect(saved.applied_by).toBe('ops@copetence.test');
    expect(await rowCount()).toBe(2);

    const [first] = await getSequelize().query<{ yaml: string }>(
      `SELECT yaml FROM instance_configs WHERE tenant_id = :tenantId AND version = 1`,
      { type: QueryTypes.SELECT, replacements: { tenantId: harness.tenantId } },
    );
    expect(first.yaml).toBe(FIXTURE_YAML);

    const rebooted = await loadActiveInstanceConfig();
    expect(rebooted.version).toBe(2);
    expect(rebooted.raw.theme?.template).toBe('slate');
  });

  it('refuses a config that would not survive schema validation', async () => {
    await loadActiveInstanceConfig();

    await expect(
      saveInstanceConfig(harness.tenantId, 'version: 1\nauth: {}\n', ANONYMOUS_ADMIN),
    ).rejects.toThrow(ConfigError);
    expect(await rowCount()).toBe(1);
  });

  it('refuses one the schema allows and the cross-field checks do not, with the loader’s own message', async () => {
    await loadActiveInstanceConfig();

    const broken = FIXTURE_YAML.replace(
      /admins:\n(\s+)groups: \[[^\]]*\]/,
      'admins:\n$1groups: [nobody-defined-this]',
    );
    expect(broken).not.toBe(FIXTURE_YAML);

    await expect(saveInstanceConfig(harness.tenantId, broken, ANONYMOUS_ADMIN)).rejects.toThrow(
      /not internally consistent[\s\S]*nobody-defined-this/,
    );
    expect(await rowCount()).toBe(1);
  });

  it('refuses a document that would leave nobody able to administer the instance', async () => {
    await loadActiveInstanceConfig();

    await expect(
      saveInstanceConfig(harness.tenantId, 'version: 1\n', ANONYMOUS_ADMIN),
    ).rejects.toThrow(/nobody able to administer[\s\S]*No administrator is configured/);
    expect(await rowCount()).toBe(1);
  });

  it('refuses one where the last thing granting the surface is a group with no sources', async () => {
    await loadActiveInstanceConfig();

    const emptied = FIXTURE_YAML.replace(
      / {2}platform-ops:\n {4}- \{ provider: entra, id: 'grp-ops' \}/,
      '  platform-ops: []',
    );
    expect(emptied).not.toBe(FIXTURE_YAML);

    await expect(saveInstanceConfig(harness.tenantId, emptied, ANONYMOUS_ADMIN)).rejects.toThrow(
      /"platform-ops" has no members/,
    );
    expect(await rowCount()).toBe(1);
  });

  it('boots on the state it refuses to save, which is the whole asymmetry', async () => {
    await clearVersions();
    await appendConfigVersion(harness.tenantId, {
      yaml: 'version: 1\n',
      resolutionHash: 'not-read-on-the-way-in',
      origin: 'admin',
      appliedBy: null,
    });

    const loaded = await loadActiveInstanceConfig();
    expect(loaded.version).toBe(1);
    expect(loaded.raw.admins).toBeUndefined();
    expect(loaded.skipped).toEqual([]);
  });

  it('refuses YAML the strict parser rejects, as a ConfigError like every other refusal', async () => {
    await loadActiveInstanceConfig();
    await expect(
      saveInstanceConfig(harness.tenantId, 'a: &x 1\nb: *x\n', ANONYMOUS_ADMIN),
    ).rejects.toThrow(ConfigError);
    await expect(
      saveInstanceConfig(harness.tenantId, 'a: &x 1\nb: *x\n', ANONYMOUS_ADMIN),
    ).rejects.toThrow(/anchor|alias/);
    expect(await rowCount()).toBe(1);
  });

  it('falls back past a version that is not even valid YAML', async () => {
    await loadActiveInstanceConfig();
    await appendConfigVersion(harness.tenantId, {
      yaml: 'a: &x 1\nb: *x\n',
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });

    const loaded = await loadActiveInstanceConfig();
    expect(loaded.version).toBe(1);
    expect(loaded.skipped[0].problems.join(' ')).toMatch(/anchor|alias/);
  });

  it('falls back to the newest version that loads when the newest one does not', async () => {
    await loadActiveInstanceConfig();

    const drifted = FIXTURE_YAML.replace(
      '${TEST_ENTRA_CLIENT_SECRET}',
      '${SPEICHER_TEST_NEVER_SET}',
    );
    expect(drifted).not.toBe(FIXTURE_YAML);
    await appendConfigVersion(harness.tenantId, {
      yaml: drifted,
      resolutionHash: 'irrelevant-to-this-test',
      origin: 'admin',
      appliedBy: 'ops@copetence.test',
    });

    const loaded = await loadActiveInstanceConfig();

    expect(loaded.version).toBe(1);
    expect(loaded.raw.auth?.providers.entra).toBeDefined();

    expect(loaded.skipped).toHaveLength(1);
    expect(loaded.skipped[0].version).toBe(2);
    expect(loaded.skipped[0].problems.join(' ')).toContain('${SPEICHER_TEST_NEVER_SET}');
  });

  it('walks back past every version that does not load, not just one', async () => {
    await loadActiveInstanceConfig();
    for (const n of [2, 3]) {
      await appendConfigVersion(harness.tenantId, {
        yaml: `version: 1\nauth: {}\n# broken ${n}\n`,
        resolutionHash: 'x',
        origin: 'admin',
        appliedBy: null,
      });
    }

    const loaded = await loadActiveInstanceConfig();
    expect(loaded.version).toBe(1);
    expect(loaded.skipped.map((s) => s.version)).toEqual([3, 2]);
  });

  it('says so at error level, because nothing else about a fallback boot looks wrong', async () => {
    await loadActiveInstanceConfig();
    await appendConfigVersion(harness.tenantId, {
      yaml: 'version: 1\nauth: {}\n',
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });

    const written: string[] = [];
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await loadActiveInstanceConfig();
    } finally {
      spy.mockRestore();
    }

    const line = written
      .map((l) => JSON.parse(l))
      .find((l) => l.msg?.includes('older instance config'));
    expect(line?.level).toBe('error');
    expect(line?.running).toBe(1);
    expect(String(line?.skipped)).toContain('v2');
  });

  it('refuses to start only when nothing at all loads, and names everything it tried', async () => {
    await appendConfigVersion(harness.tenantId, {
      yaml: 'version: 1\nauth: {}\n',
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });
    await expect(loadActiveInstanceConfig()).rejects.toThrow(
      /no stored instance config version loads \(tried 1: v1\)/,
    );
  });

  it('does not treat a defect in the loader as a version that will not load', async () => {
    await loadActiveInstanceConfig();
    await appendConfigVersion(harness.tenantId, {
      yaml: FIXTURE_YAML,
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });

    const boom = new TypeError('loader is broken');
    const spy = jest.spyOn(schemas, 'validateInstanceSchema').mockImplementation(() => {
      throw boom;
    });
    try {
      await expect(loadActiveInstanceConfig()).rejects.toBe(boom);
    } finally {
      spy.mockRestore();
    }
  });

  it('boots on a file that does not exist once a version is stored', async () => {
    await loadActiveInstanceConfig();
    process.env[INSTANCE_CONFIG_PATH_ENV] = join(__dirname, 'no-such-config.yaml');
    const loaded = await loadActiveInstanceConfig();
    expect(loaded.version).toBe(1);
  });

  it('boots unclaimed when there is neither a row nor a file', async () => {
    process.env[INSTANCE_CONFIG_PATH_ENV] = join(__dirname, 'no-such-config.yaml');
    const loaded = await loadActiveInstanceConfig();
    expect(loaded.version).toBeNull();
    expect(loaded.raw).toEqual({ version: 1 });
    expect(loaded.primaryForgeId).toBeNull();
    expect(await rowCount()).toBe(0);
  });

  it('keeps throwing when a stored version exists and none of them load', async () => {
    await appendConfigVersion(harness.tenantId, {
      yaml: 'version: 1\nauth: {}\n',
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });
    process.env[INSTANCE_CONFIG_PATH_ENV] = join(__dirname, 'no-such-config.yaml');
    await expect(loadActiveInstanceConfig()).rejects.toThrow(
      /no stored instance config version loads/,
    );
  });

  it('refuses to start on a broken file rather than replacing it with a blank instance', async () => {
    const broken = join(mkdtempSync(join(tmpdir(), 'speicher-config-')), 'broken-instance.yaml');
    writeFileSync(broken, 'version: 1\nauth: {}\n', 'utf8');
    process.env[INSTANCE_CONFIG_PATH_ENV] = broken;

    await expect(loadActiveInstanceConfig()).rejects.toThrow(/failed schema validation/);
    expect(await rowCount()).toBe(0);
  });
});

describe('the dashboard says which mode is in force', () => {
  let app: INestApplication;
  let cookie: string;

  afterEach(async () => {
    await app?.close();
  });

  async function boot(config: ConfigService): Promise<void> {
    app = await bootTestApp(config);
    cookie = await sessionCookieFor(harness.tenantId, 'ops');
  }

  it('names the file, and says the file is the one to edit', async () => {
    await boot(new ConfigService(loadInstanceConfigFromFile(ORIGINAL_PATH)));

    const json = await request(app.getHttpServer())
      .get('/-/status')
      .set('cookie', cookie)
      .set('accept', 'application/json')
      .expect(200);
    expect(json.body.instance.config_source).toBe('file');
    expect(json.body.instance.config_version).toBeNull();

    const page = await request(app.getHttpServer())
      .get('/-/config')
      .set('cookie', cookie)
      .expect(200);
    expect(page.text).toContain('The file is authoritative');
  });

  it('names the version, in database mode', async () => {
    process.env[CONFIG_SOURCE_ENV] = 'database';
    await clearVersions();
    await loadActiveInstanceConfig();
    await saveInstanceConfig(harness.tenantId, FIXTURE_YAML, ADMIN);
    await boot(new ConfigService(await loadActiveInstanceConfig()));

    const json = await request(app.getHttpServer())
      .get('/-/status')
      .set('cookie', cookie)
      .set('accept', 'application/json')
      .expect(200);
    expect(json.body.instance.config_source).toBe('database');
    expect(json.body.instance.config_version).toBe(2);

    expect(json.body.instance.config_skipped).toEqual([]);
    for (const where of ['/-/status', '/-/config']) {
      const page = await request(app.getHttpServer()).get(where).set('cookie', cookie).expect(200);
      expect(page.text).not.toContain('version 2');
      expect(page.text).not.toContain('does not load');
    }
  });

  it('shows which version was skipped and why, on a fallback boot', async () => {
    process.env[CONFIG_SOURCE_ENV] = 'database';
    await clearVersions();
    await loadActiveInstanceConfig();
    await appendConfigVersion(harness.tenantId, {
      yaml: FIXTURE_YAML.replace('${TEST_GH_APP_ID}', '${SPEICHER_TEST_NEVER_SET}'),
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: 'ops@copetence.test',
    });
    await boot(new ConfigService(await loadActiveInstanceConfig()));

    const json = await request(app.getHttpServer())
      .get('/-/status')
      .set('cookie', cookie)
      .set('accept', 'application/json')
      .expect(200);
    expect(json.body.instance.config_version).toBe(1);
    expect(json.body.instance.config_skipped).toHaveLength(1);
    expect(json.body.instance.config_skipped[0].version).toBe(2);

    const page = await request(app.getHttpServer())
      .get('/-/config')
      .set('cookie', cookie)
      .expect(200);
    expect(page.text).toContain('Version 2 does not load</h2>');
    expect(page.text).toContain('The current instance config version is 1.');
    expect(page.text).toContain('<span class="spr-version-label">Version 2</span>');
    expect(page.text).toContain('SPEICHER_TEST_NEVER_SET');
  });

  it('keeps the instance panel admin-only whichever mode it is in', async () => {
    process.env[CONFIG_SOURCE_ENV] = 'database';
    await clearVersions();
    await loadActiveInstanceConfig();
    await boot(new ConfigService(await loadActiveInstanceConfig()));

    const maintainer = await sessionCookieFor(harness.tenantId, 'alice');
    const json = await request(app.getHttpServer())
      .get('/-/status')
      .set('cookie', maintainer)
      .set('accept', 'application/json');
    expect(json.status === 404 || json.body.instance === null).toBe(true);
  });
});
