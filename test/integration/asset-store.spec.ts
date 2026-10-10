import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import {
  DIRECTORY_FAIL_LABEL,
  DIRECTORY_OK_LABEL,
  FilesystemBlobStore,
} from '../../src/assets/blob-store';
import { ConfigService } from '../../src/config/config.service';
import { NOT_IN_USE_YET } from '../../src/dashboard/configurator/config-page/checks';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let harness: Harness;
let app: INestApplication;
let ops: string;

let dir: string;
let volume: string;

const instanceYaml = (path: string): string => `
version: 1
auth:
  providers:
    entra:
      type: oidc
      issuer: https://login.microsoftonline.com/a-tenant/v2.0
      client_id: sign-in-client
      subject_claim: oid
groups:
  platform-ops:
    - { provider: entra, id: grp-ops }
admins:
  groups: [platform-ops]
assets:
  driver: filesystem
  path: ${path}
`;

beforeAll(async () => {
  harness = await createHarness();
  ops = await sessionCookieFor(harness.tenantId, 'ops');

  dir = mkdtempSync(join(tmpdir(), 'speicher-assets-'));
  volume = join(dir, 'blobs');
  mkdirSync(volume, { recursive: true });
  writeFileSync(join(dir, 'instance.yaml'), instanceYaml(volume), 'utf8');

  app = await bootTestApp(
    new ConfigService(loadInstanceConfigFromFile(join(dir, 'instance.yaml'))),
  );
});

afterAll(async () => {
  await app?.close();
  await harness?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const page = () =>
  request(app.getHttpServer()).get('/-/config/storage').set('cookie', ops).expect(200);

const checked = () =>
  request(app.getHttpServer()).get('/-/config/storage?check=1').set('cookie', ops).expect(200);

describe('the store check on the storage page', () => {
  it('offers the check rather than making it, so the page never waits for a store', async () => {
    const { text } = await page();

    expect(text).toContain('data-spr-check="/-/config/storage?check=1"');
    expect(text).toContain('Check the connection');
    expect(text).not.toContain(DIRECTORY_OK_LABEL);
    expect(text).toContain('data-spr-check-mark="ok"');
    expect(text).toContain('data-spr-check-mark="fail"');
  });

  it('says the volume is writable, at the foot of the page', async () => {
    const { text } = await checked();

    expect(text).toContain('spr-note-ok');
    expect(text).toContain(DIRECTORY_OK_LABEL);
    expect(text).toContain(resolve(volume));
    const form = text.slice(text.indexOf('<form class="spr-config"'));
    const status = form.indexOf('spr-section-status');
    expect(status).toBeGreaterThan(form.lastIndexOf('name="assets.presign_ttl"'));
    expect(status).toBeLessThan(form.indexOf('</form>'));
  });

  it('notices the volume going away, without a restart', async () => {
    rmSync(volume, { recursive: true, force: true });
    const { text } = await checked();

    expect(text).toContain('spr-note-fail');
    expect(text).toContain(DIRECTORY_FAIL_LABEL);
    expect(text).toContain('does not exist');
  });
});

describe('a store this process is not running', () => {
  const path = () => join(dir, 'instance.yaml');

  afterAll(() => writeFileSync(path(), instanceYaml(volume), 'utf8'));

  it('checks what the page says rather than what the process holds', async () => {
    mkdirSync(volume, { recursive: true });
    writeFileSync(
      path(),
      `${instanceYaml(volume).replace(/assets:[\s\S]*$/, '')}assets:
  driver: azure
  account: acmedocs
  container: assets
`,
      'utf8',
    );

    const { text } = await checked();

    expect(text).toContain('Azure Blob Storage');
    expect(text).toContain('account_key is required');
    expect(text).toContain('spr-note-fail');
    expect(text).toContain(NOT_IN_USE_YET);
    expect(text).toContain('until it restarts');
    expect(text).not.toContain(DIRECTORY_OK_LABEL);
  });

  it('lists every missing s3 setting at once, rather than the first one', async () => {
    writeFileSync(
      path(),
      `${instanceYaml(volume).replace(/assets:[\s\S]*$/, '')}assets:
  driver: s3
  bucket: acmedocs
  region: eu-central-1
`,
      'utf8',
    );

    const { text } = await checked();

    expect(text).toContain('S3-compatible');
    expect(text).toContain('access_key_id is required');
    expect(text).toContain('secret_access_key is required');
    expect(text).toContain('spr-note-fail');
    expect(text).toContain(NOT_IN_USE_YET);
  });

  it('reports a store that works before anything has restarted', async () => {
    const second = join(dir, 'other-blobs');
    mkdirSync(second, { recursive: true });
    writeFileSync(path(), instanceYaml(second), 'utf8');

    const { text } = await checked();

    expect(text).toContain(DIRECTORY_OK_LABEL);
    expect(text).toContain(resolve(second));
    expect(text).toContain('spr-note-warn');
    expect(text).toContain(NOT_IN_USE_YET);
  });
});

describe('the filesystem driver', () => {
  it('never creates the volume it is asked about', async () => {
    const missing = join(dir, 'never-made');
    const status = await new FilesystemBlobStore(missing).probe();

    expect(status.level).toBe('fail');
    expect(status.detail).toContain(resolve(missing));
    expect(await new FilesystemBlobStore(missing).probe()).toEqual(status);
  });
});
