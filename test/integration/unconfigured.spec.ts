import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ConfigService } from '../../src/config/config.service';
import {
  CONFIG_SOURCE_ENV,
  INSTANCE_CONFIG_PATH_ENV,
  loadActiveInstanceConfig,
} from '../../src/config/loader';
import { loadInstanceConfig } from '../../src/config/parser';
import { closeSequelize } from '../../src/db/sequelize';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

const MINIMAL_PATH = join(__dirname, '../fixtures/instance-minimal.yaml');
const MINIMAL_YAML = readFileSync(MINIMAL_PATH, 'utf8');

const ORIGINAL_SOURCE = process.env[CONFIG_SOURCE_ENV];
const ORIGINAL_PATH = process.env[INSTANCE_CONFIG_PATH_ENV] as string;

let harness: Harness;
let app: INestApplication;
let ops: string;

beforeAll(async () => {
  harness = await createHarness();
  ops = await sessionCookieFor(harness.tenantId, 'ops');
  app = await bootTestApp(new ConfigService(loadInstanceConfig(MINIMAL_YAML)));
});

afterAll(async () => {
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

const get = (path: string) => request(app.getHttpServer()).get(path);

describe('the operational surface', () => {
  it.each(['/-/status', '/-/config', '/-/dead-jobs', '/-/graph', '/-/explain?path=/handbook'])(
    '404s %s, whoever asks',
    async (path) => {
      expect((await get(path).set('cookie', ops)).status).toBe(404);
      expect((await get(path)).status).toBe(404);
    },
  );

  it('is not a 403 anywhere, because that would say the instance has one', async () => {
    const response = await get('/-/status').set('cookie', ops);
    expect(response.status).not.toBe(403);
  });
});

describe('the reader', () => {
  it('serves with no primary forge to build a URL from', async () => {
    const response = await get('/').expect(200);
    expect(response.text).toContain('<html');
  });

  it('names each provider the way a reader is offered it', async () => {
    const configured = new ConfigService(
      loadInstanceConfig(
        [
          'version: 1',
          'auth:',
          '  providers:',
          '    entra:',
          '      type: oidc',
          "      display_name: 'Acme Account'",
          '      issuer: https://login.example.test/v2.0',
          '      client_id: c',
          '    okta:',
          '      type: oidc',
          '      issuer: https://okta.example.test',
          '      client_id: d',
        ].join('\n'),
      ),
    );
    const app = await bootTestApp(configured);
    try {
      const page = await request(app.getHttpServer()).get('/api/auth/login').expect(200);
      expect(page.text).toContain('Sign in with Acme Account');
      expect(page.text).toContain('Sign in with okta');
      expect(page.text.match(/class="spr-signin-option"/g)).toHaveLength(2);
      expect(page.text).toContain('<symbol id="m-openid"');
      expect(page.text).toContain('href="#m-openid"');
      expect(page.text).not.toMatch(/<img/);
    } finally {
      await app.close();
    }
  });

  it('offers sign-in without a provider to offer', async () => {
    await get('/api/auth/login').expect(200);
  });

  it('404s a page whose repository this configuration names no way to reach', async () => {
    await get('/handbook/introduction').expect(404);
  });
});

describe('the probes', () => {
  it('answer, because unconfigured is not unhealthy', async () => {
    await get('/-/healthz').expect(200);
    await get('/-/readyz').expect(200);
  });
});

describe('a `file`-mode boot with no administrator', () => {
  let written: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    written = [];
    spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    process.env[CONFIG_SOURCE_ENV] = 'file';
    process.env[INSTANCE_CONFIG_PATH_ENV] = MINIMAL_PATH;
  });

  afterEach(() => {
    spy.mockRestore();
    if (ORIGINAL_SOURCE === undefined) delete process.env[CONFIG_SOURCE_ENV];
    else process.env[CONFIG_SOURCE_ENV] = ORIGINAL_SOURCE;
    process.env[INSTANCE_CONFIG_PATH_ENV] = ORIGINAL_PATH;
  });

  const lines = () => written.map((line) => JSON.parse(line) as Record<string, unknown>);

  it('boots, and says at error level that it cannot be administered', async () => {
    const loaded = await loadActiveInstanceConfig();
    expect(loaded.raw.admins).toBeUndefined();

    const line = lines().find((l) => l.code === 'admins.none');
    expect(line?.level).toBe('error');
    expect(line?.code).toBe('admins.none');
    expect(line?.config).toBe(MINIMAL_PATH);
  });

  it('says nothing when there is an administrator', async () => {
    process.env[INSTANCE_CONFIG_PATH_ENV] = ORIGINAL_PATH;
    await loadActiveInstanceConfig();
    expect(lines().find((l) => l.msg === 'this instance has no administrator')).toBeUndefined();
  });
});
