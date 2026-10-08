import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import request from 'supertest';

import { runCli } from '../../src/cli/cli';
import { ConfigService } from '../../src/config/config.service';
import { appendConfigVersion, getNewestConfigVersion } from '../../src/config/loader';
import { loadInstanceConfig, loadInstanceConfigFromFile } from '../../src/config/parser';
import { CODE_SHAPE } from '../../src/dashboard/setup/claim-code';
import { MAX_LIVE_CLAIMS, setup } from '../../src/dashboard/setup/setup.service';
import { unclaimedInstanceConfig } from '../../src/dashboard/setup/unclaimed';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp } from '../helpers/http';

const ROOT = resolve(__dirname, '../..');

let harness: Harness;
let app: INestApplication;

const ORIGINAL_INSECURE = process.env.SPEICHER_INSECURE_COOKIES;

beforeAll(async () => {
  harness = await createHarness();
  process.env.SPEICHER_INSECURE_COOKIES = 'true';
});

beforeEach(async () => {
  await resetSetupState();
  app = await bootTestApp(new ConfigService(unclaimedInstanceConfig()));
});

afterEach(async () => {
  await app?.close();
});

afterAll(async () => {
  if (ORIGINAL_INSECURE === undefined) delete process.env.SPEICHER_INSECURE_COOKIES;
  else process.env.SPEICHER_INSECURE_COOKIES = ORIGINAL_INSECURE;
  await harness?.close();
  await closeSequelize();
});

async function resetSetupState(): Promise<void> {
  await getSequelize().query(`DELETE FROM setup_claims`, { type: QueryTypes.DELETE });
  await getSequelize().query(`DELETE FROM instance_configs`, { type: QueryTypes.DELETE });
  await getSequelize().query(
    `UPDATE tenants SET first_admin_login_at = NULL, setup_reopened_at = NULL,
            setup_reopen_count = 0`,
    { type: QueryTypes.UPDATE },
  );
}

const FRESH = { source: 'database', hasAdministrator: false } as const;

function browser() {
  return request.agent(app.getHttpServer());
}

function codeOn(html: string): string {
  const match = html.match(/speicher claim ([A-Z-]+-[0-9]{4})/);
  if (!match) throw new Error(`no claim code on the page:\n${html.slice(0, 400)}`);
  return match[1];
}

describe('the front door of an instance nobody has configured', () => {
  it('offers the claim, and discloses nothing else about the instance', async () => {
    const response = await browser().get('/').expect(200);

    const code = codeOn(response.text);
    expect(CODE_SHAPE.test(code)).toBe(true);
    expect(response.text).toContain('docker compose exec web speicher claim');
    expect(response.text).not.toContain('handbook');
    expect(response.text).not.toContain('entra');
  });

  it('offers Copy as an upgrade, so a page with no clipboard loses nothing', async () => {
    const { text } = await browser().get('/').expect(200);
    const buttons = [...text.matchAll(/<button[^>]*data-spr-clipboard="[^"]*"[^>]*>/g)].map(
      (m) => m[0],
    );
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button).toMatch(/\shidden\b/);
    expect(buttons[0]).toContain('aria-label="Copy command"');
    expect(buttons[1]).toContain('aria-label="Copy code"');
    const command = /<pre class="spr-claim-command"><code>([^<]*)<\/code><\/pre>/.exec(text)?.[1];
    const code = /<dt>Code<\/dt>\s*<dd>\s*<code>([^<]*)<\/code>/.exec(text)?.[1];
    expect(command).toMatch(/^docker compose exec web speicher claim /);
    expect(buttons[0]).toContain(`data-spr-clipboard="${command}"`);
    expect(buttons[1]).toContain(`data-spr-clipboard="${code}"`);
    expect(text).toMatch(/<p class="spr-copy-status" role="status"[^>]*><\/p>/);
  });

  it('is never handed to a second reader by a shared cache', async () => {
    const response = await browser().get('/').expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(String(response.headers['set-cookie'])).toContain('speicher_claim=');
  });

  it('is not cached on a reload, which sets no cookie', async () => {
    const original = process.env.SPEICHER_PUBLIC_MAX_AGE;
    process.env.SPEICHER_PUBLIC_MAX_AGE = '60';
    try {
      const agent = browser();
      await agent.get('/').expect(200);
      const reload = await agent.get('/').expect(200);
      expect(reload.headers['set-cookie']).toBeUndefined();
      expect(reload.headers['cache-control']).toBe('private, no-store');
    } finally {
      if (original === undefined) delete process.env.SPEICHER_PUBLIC_MAX_AGE;
      else process.env.SPEICHER_PUBLIC_MAX_AGE = original;
    }
  });

  it('carries its own stylesheet, which no documentation page ever downloads', () => {
    expect(
      existsSync(
        join(ROOT, 'src', 'dashboard', 'ui', 'views', 'setup', 'setup-claim', 'setup-claim.css'),
      ),
    ).toBe(true);
    const base = readFileSync(join(ROOT, 'src', 'global-ui', 'theme', 'default.css'), 'utf8');
    expect(base).not.toContain('spr-claim-');
    expect(base).not.toContain('spr-step');
  });

  it('shows the same code on a reload rather than minting a second claim', async () => {
    const agent = browser();
    const first = codeOn((await agent.get('/').expect(200)).text);
    const second = codeOn((await agent.get('/').expect(200)).text);
    expect(second).toBe(first);
    expect(await setup.pending(harness.tenantId)).toHaveLength(1);
  });

  it('cannot be made to grow without bound by a loop over the front door', async () => {
    const mine = browser();
    const code = codeOn((await mine.get('/').expect(200)).text);
    expect(await runCli(['claim', code])).toBe(0);

    for (let i = 0; i < MAX_LIVE_CLAIMS + 20; i += 1) {
      await browser().get('/').expect(200);
    }

    const pending = await setup.pending(harness.tenantId);
    expect(pending.filter((c) => c.approved_at === null).length).toBeLessThanOrEqual(
      MAX_LIVE_CLAIMS,
    );
    expect(pending.map((c) => c.code)).toContain(code);
    await mine.get('/').expect(303);
  });

  it('gives a browser with no claim of its own nothing to poll for', async () => {
    const { body } = await browser().get('/api/setup/claim').expect(200);
    expect(body.status).toBe('gone');
  });

  it('administers nothing until the claim is approved, and says where to start', async () => {
    const agent = browser();
    await agent.get('/').expect(200);

    for (const path of ['/-/status', '/-/setup', '/-/config', '/handbook/anything']) {
      const response = await agent.get(path);
      expect([response.status, response.headers.location]).toEqual([303, '/']);
    }
    expect(await setup.pending(harness.tenantId)).toHaveLength(1);
  });
});

describe('approval lands on the browser that asked, and on no other', () => {
  it('signs in the browser holding the cookie, and leaves the watcher watching', async () => {
    const mine = browser();
    const yours = browser();

    const myCode = codeOn((await mine.get('/').expect(200)).text);
    const yourCode = codeOn((await yours.get('/').expect(200)).text);
    expect(yourCode).not.toBe(myCode);

    expect(await runCli(['claim', myCode])).toBe(0);

    const redeemed = await mine.get('/').expect(303);
    expect(redeemed.headers.location).toBe('/-/setup');
    await mine.get('/-/setup').expect(200);

    await yours.get('/-/setup').expect(303);
    expect(codeOn((await yours.get('/').expect(200)).text)).toBe(yourCode);
  });

  it('sends the claimed browser to the wizard, without minting another claim', async () => {
    const agent = browser();
    const code = codeOn((await agent.get('/').expect(200)).text);
    await runCli(['claim', code]);
    await agent.get('/').expect(303);

    const again = await agent.get('/').expect(303);
    expect(again.headers.location).toBe('/-/setup');
    expect(await setup.pending(harness.tenantId)).toHaveLength(0);

    const wizard = await agent.get('/-/setup').expect(200);
    expect(wizard.text).toContain('Set up this instance');

    const config = await agent.get('/-/config').expect(200);
    expect(config.text).toContain('Identity');
  });

  it('spends a claim once', async () => {
    const agent = browser();
    const code = codeOn((await agent.get('/').expect(200)).text);
    await runCli(['claim', code]);
    await agent.get('/').expect(303);
    expect(await setup.redeem(harness.tenantId, 'anything')).toBeNull();
  });

  it('costs nothing to lose the session and start again', async () => {
    const first = browser();
    await runCli(['claim', codeOn((await first.get('/').expect(200)).text)]);
    await first.get('/').expect(303);

    const second = browser();
    const code = codeOn((await second.get('/').expect(200)).text);
    expect(await runCli(['claim', code])).toBe(0);
    await second.get('/').expect(303);
    await second.get('/-/setup').expect(200);
  });

  it('answers the poll without ever minting a session itself', async () => {
    const agent = browser();
    const code = codeOn((await agent.get('/').expect(200)).text);

    expect((await agent.get('/api/setup/claim').expect(200)).body.status).toBe('pending');
    await runCli(['claim', code]);
    const polled = await agent.get('/api/setup/claim').expect(200);
    expect(polled.body.status).toBe('approved');
    expect(polled.headers['set-cookie']).toBeUndefined();
    await agent.get('/-/status').expect(303);
  });
});

describe('the claim window, which has only ever moved one way', () => {
  it('is closed by the first admin login and by nothing else', async () => {
    expect(await setup.showsClaimPage(harness.tenantId, FRESH)).toBe(true);

    expect(await setup.latchFirstAdminLogin(harness.tenantId)).toBe(true);
    expect(await setup.showsClaimPage(harness.tenantId, FRESH)).toBe(false);

    expect(await setup.latchFirstAdminLogin(harness.tenantId)).toBe(false);
  });

  it('stays shut through every regression of current state', async () => {
    await setup.latchFirstAdminLogin(harness.tenantId);
    expect(await setup.showsClaimPage(harness.tenantId, FRESH)).toBe(false);
    expect(await setup.claimWindowOpen(harness.tenantId)).toBe(false);

    await setup.reopen(harness.tenantId);
    expect(await setup.showsClaimPage(harness.tenantId, FRESH)).toBe(true);
  });

  it('refuses an approval once it is shut, rather than quietly recording one', async () => {
    const agent = browser();
    const code = codeOn((await agent.get('/').expect(200)).text);
    await setup.latchFirstAdminLogin(harness.tenantId);

    expect(await runCli(['claim', code])).toBe(1);
    expect(await setup.approve(harness.tenantId, code)).toEqual({ status: 'closed' });
  });

  it('survives the wizard writing a configuration, which is the resume path', async () => {
    await getSequelize().query(
      `INSERT INTO instance_configs (tenant_id, version, yaml, resolution_hash, origin)
       VALUES (:tenantId, 1, 'version: 1', 'x', 'setup')`,
      { type: QueryTypes.INSERT, replacements: { tenantId: harness.tenantId } },
    );
    expect(await setup.showsClaimPage(harness.tenantId, FRESH)).toBe(true);

    expect(await setup.showsClaimPage(harness.tenantId, { ...FRESH, hasAdministrator: true })).toBe(
      false,
    );
  });

  it('is not opened by an instance whose configuration is a file', async () => {
    const fileMode = new ConfigService(
      loadInstanceConfigFromFile(process.env.SPEICHER_CONFIG as string),
    );
    expect(fileMode.configSource).toBe('file');
    expect(
      await setup.showsClaimPage(harness.tenantId, {
        source: fileMode.configSource,
        hasAdministrator: false,
      }),
    ).toBe(false);
  });
});

describe('reopening it', () => {
  it('reopens once, counts itself, and says so when there was nothing to do', async () => {
    await setup.latchFirstAdminLogin(harness.tenantId);

    expect(await runCli(['reopen-claim-window'])).toBe(0);
    expect(await setup.showsClaimPage(harness.tenantId, FRESH)).toBe(true);
    expect(await reopenCount()).toBe(1);

    expect(await runCli(['reopen-claim-window'])).toBe(0);
    expect(await reopenCount()).toBe(1);
  });
});

describe('the login that closes it', () => {
  let configured: INestApplication;
  const ORIGINAL_DEV_LOGIN = process.env.SPEICHER_DEV_LOGIN;

  beforeEach(async () => {
    process.env.SPEICHER_DEV_LOGIN = 'true';
    configured = await bootTestApp(harness.config);
  });

  afterEach(async () => {
    if (ORIGINAL_DEV_LOGIN === undefined) delete process.env.SPEICHER_DEV_LOGIN;
    else process.env.SPEICHER_DEV_LOGIN = ORIGINAL_DEV_LOGIN;
    await configured?.close();
  });

  it('closes on an administrator and not on a reader', async () => {
    await request(configured.getHttpServer())
      .get('/api/auth/dev-login?subject=alice-oid&groups=grp-eng')
      .expect(302);
    expect(await setup.showsClaimPage(harness.tenantId, FRESH)).toBe(true);

    await request(configured.getHttpServer())
      .get('/api/auth/dev-login?subject=ops-oid&groups=grp-ops')
      .expect(302);
    expect(await setup.showsClaimPage(harness.tenantId, FRESH)).toBe(false);
  });
});

describe('`speicher admin add`, the offline path', () => {
  const ORIGINAL_SOURCE = process.env.SPEICHER_CONFIG_SOURCE;

  beforeEach(async () => {
    process.env.SPEICHER_CONFIG_SOURCE = 'database';
    await appendConfigVersion(harness.tenantId, {
      yaml: readFileSync(process.env.SPEICHER_CONFIG as string, 'utf8'),
      resolutionHash: 'seed',
      origin: 'file',
      appliedBy: null,
    });
  });

  afterEach(() => {
    if (ORIGINAL_SOURCE === undefined) delete process.env.SPEICHER_CONFIG_SOURCE;
    else process.env.SPEICHER_CONFIG_SOURCE = ORIGINAL_SOURCE;
  });

  it('appends a version that names the person, and keeps the rest of the file', async () => {
    expect(
      await runCli([
        'admin',
        'add',
        '--provider',
        'entra',
        '--subject',
        'new-admin-oid',
        '--note',
        'Ferdinand, after the IdP outage',
      ]),
    ).toBe(0);

    const saved = await getNewestConfigVersion(harness.tenantId);
    expect(saved?.version).toBe(2);
    expect(saved?.yaml).toContain('new-admin-oid');
    expect(saved?.yaml).toContain("The instance's half of a public grant");
    expect(loadInstanceConfig(saved?.yaml as string).raw.admins?.users).toEqual([
      { provider: 'entra', subject: 'new-admin-oid', note: 'Ferdinand, after the IdP outage' },
    ]);
  });

  it('is refused by the loader when the grant names a provider that does not exist', async () => {
    expect(
      await runCli(['admin', 'add', '--provider', 'okta', '--subject', 'someone', '--note', 'x']),
    ).toBe(1);
    expect((await getNewestConfigVersion(harness.tenantId))?.version).toBe(1);
  });
});

async function reopenCount(): Promise<number> {
  const rows = await getSequelize().query<{ count: number }>(
    `SELECT setup_reopen_count AS count FROM tenants WHERE id = :tenantId`,
    { type: QueryTypes.SELECT, replacements: { tenantId: harness.tenantId } },
  );
  return Number(rows[0].count);
}
