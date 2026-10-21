import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import { probeMail } from '../../src/notify/mailer';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';
import { SmtpSink, startSmtpSink } from '../helpers/smtp-sink';

let smtp: SmtpSink;

beforeAll(async () => {
  smtp = await startSmtpSink();
});

afterAll(async () => {
  await smtp?.close();
});

describe('the transport check itself', () => {
  const mail = (over: Record<string, unknown> = {}) => ({
    host: '127.0.0.1',
    port: smtp.port,
    from: 'Docs <docs@example.test>',
    ...over,
  });

  it('signs in, and says so with the account it signed in as', async () => {
    const status = await probeMail(mail({ username: 'docs', password: 'secret' }));

    expect(status.level).toBe('ok');
    expect(status.label).toBe('Connected and signed in');
    expect(status.detail).toContain('as docs');
    expect(smtp.verbs).toContain('AUTH');
    expect(smtp.verbs).not.toContain('MAIL');
    expect(smtp.verbs).not.toContain('DATA');
  });

  it('reports the server’s own refusal, not a sentence of ours', async () => {
    smtp.rejectLogin = true;
    const status = await probeMail(mail({ username: 'docs', password: 'wrong' }));
    smtp.rejectLogin = false;

    expect(status.level).toBe('fail');
    expect(status.label).toBe('Not connected');
    expect(status.detail).toContain('535');
  });

  it('connects without credentials, where none are configured', async () => {
    const status = await probeMail(mail());
    expect(status.level).toBe('ok');
    expect(status.label).toBe('Connected');
    expect(status.detail).not.toContain(' as ');
  });

  it('gives up on a port nothing is listening on, rather than holding the page', async () => {
    const started = Date.now();
    const status = await probeMail(mail({ port: 1 }));

    expect(status.level).toBe('fail');
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 10_000);
});

describe('the check on the mail page', () => {
  let harness: Harness;
  let app: INestApplication;
  let ops: string;
  let dir: string;

  const instanceYaml = (port: number): string => `
version: 1
mail:
  host: 127.0.0.1
  port: ${port}
  username: docs
  password: secret
  from: Docs <docs@example.test>
auth:
  providers:
    entra:
      type: oidc
      issuer: https://login.microsoftonline.com/a-tenant/v2.0
      client_id: sign-in-client
      client_secret: sign-in-secret
      subject_claim: oid
groups:
  platform-ops:
    - { provider: entra, id: grp-ops }
admins:
  groups: [platform-ops]
`;

  beforeAll(async () => {
    harness = await createHarness();
    ops = await sessionCookieFor(harness.tenantId, 'ops');

    dir = mkdtempSync(join(tmpdir(), 'speicher-mail-'));
    writeFileSync(join(dir, 'instance.yaml'), instanceYaml(smtp.port), 'utf8');
    app = await bootTestApp(
      new ConfigService(loadInstanceConfigFromFile(join(dir, 'instance.yaml'))),
    );
  });

  afterAll(async () => {
    await app?.close();
    await harness?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const page = (query = '') =>
    request(app.getHttpServer()).get(`/-/config/mail${query}`).set('cookie', ops).expect(200);

  it('offers the check rather than making it', async () => {
    const { text } = await page();

    expect(text).toContain('data-spr-check="/-/config/mail?check=1"');
    expect(text).toContain('Check the connection');
    expect(text).not.toContain('Connected and signed in');
  });

  it('answers when it is asked for', async () => {
    const { text } = await page('?check=1');

    expect(text).toContain('spr-note-ok');
    expect(text).toContain('Connected and signed in');
    expect(text).toContain('as docs');
  });

  it('offers nothing on a page with no transport to check', async () => {
    writeFileSync(
      join(dir, 'instance.yaml'),
      instanceYaml(smtp.port).replace(/mail:[\s\S]*?from:[^\n]*\n/, ''),
      'utf8',
    );

    const { text } = await page('?check=1');
    expect(text).not.toContain('data-spr-check');
    expect(text).not.toContain('spr-section-status');

    writeFileSync(join(dir, 'instance.yaml'), instanceYaml(smtp.port), 'utf8');
  });
});
