import { Server, createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { QueryTypes } from 'sequelize';
import request from 'supertest';

import { runCli } from '../../src/cli/cli';
import { ConfigService } from '../../src/config/config.service';
import {
  CONFIG_SOURCE_ENV,
  INSTANCE_CONFIG_PATH_ENV,
  getNewestConfigVersion,
} from '../../src/config/loader';
import { loadInstanceConfig } from '../../src/config/parser';
import { setup } from '../../src/dashboard/setup/setup.service';
import { GithubAppManifestService } from '../../src/dashboard/configurator/config-page/github-app-manifest';
import { ConfigWatcher } from '../../src/config/watcher';
import { saveInstanceConfig } from '../../src/config/loader';
import { subjectPrincipal } from '../../src/common/principals';
import { unclaimedInstanceConfig } from '../../src/dashboard/setup/unclaimed';
import { loadDocument } from '../../src/dashboard/configurator/config-form/document';
import { LoginFlow } from '../../src/db/models';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { Mailer } from '../../src/notify/mailer';
import { formBody } from '../helpers/form';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp } from '../helpers/http';

let harness: Harness;
let app: INestApplication;
let idp: FakeIdp;
let config: ConfigService;

const CLIENT_ID = 'wizard-client';
const GITHUB_CLIENT_ID = 'wizard-github-client';
const ORIGINAL_PUBLIC_URL = process.env.SPEICHER_PUBLIC_URL;
const ORIGINAL_SOURCE = process.env[CONFIG_SOURCE_ENV];
const ORIGINAL_PATH = process.env[INSTANCE_CONFIG_PATH_ENV];
const ORIGINAL_INSECURE = process.env.SPEICHER_INSECURE_COOKIES;
const sent: { to: string; subject: string; text: string }[] = [];

const manifestGithub = (async () =>
  new Response(
    JSON.stringify({
      id: 4242,
      slug: 'speicher-mine',
      owner: { login: 'octo', type: 'User' },
      html_url: 'https://github.com/apps/speicher-mine',
      pem: 'unused',
      webhook_secret: null,
      client_id: 'Iv1.mine',
      client_secret: 'mine',
    }),
    { status: 201 },
  )) as typeof fetch;

beforeAll(async () => {
  harness = await createHarness();
  idp = await startFakeIdp();
  process.env.SPEICHER_INSECURE_COOKIES = 'true';
});

beforeEach(async () => {
  process.env[CONFIG_SOURCE_ENV] = 'database';
  process.env[INSTANCE_CONFIG_PATH_ENV] = '/nonexistent/speicher.instance.yaml';
  await reset();
  config = new ConfigService(unclaimedInstanceConfig());
  sent.length = 0;
  const mailer = new Mailer(config);
  mailer.send = async (to, subject, text) => {
    sent.push({ to, subject, text });
  };
  app = await bootTestApp(
    config,
    [],
    [
      { token: Mailer, value: mailer },
      // GitHub, as it hands over an App it created on the person's own account
      { token: GithubAppManifestService, value: new GithubAppManifestService(manifestGithub) },
    ],
  );
});

afterEach(async () => {
  await app?.close();
  if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.SPEICHER_PUBLIC_URL;
  else process.env.SPEICHER_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
});

afterAll(async () => {
  if (ORIGINAL_SOURCE === undefined) delete process.env[CONFIG_SOURCE_ENV];
  else process.env[CONFIG_SOURCE_ENV] = ORIGINAL_SOURCE;
  if (ORIGINAL_PATH === undefined) delete process.env[INSTANCE_CONFIG_PATH_ENV];
  else process.env[INSTANCE_CONFIG_PATH_ENV] = ORIGINAL_PATH;
  if (ORIGINAL_INSECURE === undefined) delete process.env.SPEICHER_INSECURE_COOKIES;
  else process.env.SPEICHER_INSECURE_COOKIES = ORIGINAL_INSECURE;
  await idp?.stop();
  await harness?.close();
  await closeSequelize();
});

async function reset(): Promise<void> {
  const db = getSequelize();
  await db.query(`DELETE FROM setup_claims`, { type: QueryTypes.DELETE });
  await db.query(`DELETE FROM instance_configs`, { type: QueryTypes.DELETE });
  await db.query(`DELETE FROM login_flows`, { type: QueryTypes.DELETE });
  await db.query(`DELETE FROM magic_link_tokens`, { type: QueryTypes.DELETE });
  await db.query(`DELETE FROM rate_limits`, { type: QueryTypes.DELETE });
  await db.query(
    `UPDATE tenants SET first_admin_login_at = NULL, setup_completed_at = NULL, setup_reopen_count = 0`,
    { type: QueryTypes.UPDATE },
  );
  // A fresh instance: nobody can read a page yet
  await db.query(`UPDATE documents SET effective_principals = '{}'`, { type: QueryTypes.UPDATE });
}

/** Lets the first administrator, named by the fake IdP's login, read the handbook */
async function grantHandbook(): Promise<void> {
  await getSequelize().query(
    `UPDATE documents SET effective_principals = ARRAY[:principal] WHERE repo_id = :repoId`,
    {
      type: QueryTypes.UPDATE,
      replacements: {
        principal: subjectPrincipal('wizard', 'subject-from-the-idp'),
        repoId: harness.repos.handbook,
      },
    },
  );
}

function browser() {
  return request.agent(app.getHttpServer());
}

type Agent = ReturnType<typeof browser>;

async function claim(): Promise<Agent> {
  const agent = browser();
  const page = await agent.get('/').expect(200);
  const code = (page.text.match(/speicher claim ([A-Z-]+-[0-9]{4})/) ?? [])[1];
  expect(await runCli(['claim', code])).toBe(0);
  await agent.get('/').expect(303);
  return agent;
}

async function addProvider(agent: Agent, id = 'wizard'): Promise<void> {
  await agent.get(`/-/config/identity?add=${id}&kind=oidc`).expect(303);
  const draft = await agent.get(`/-/config/identity/${id}?kind=oidc`).expect(200);
  await agent
    .post(`/-/config/identity/${id}?kind=oidc`)
    .send({
      ...formBody(draft.text),
      [`auth.providers.${id}.issuer`]: idp.issuer,
      [`auth.providers.${id}.client_id`]: CLIENT_ID,
      intent: 'apply',
    })
    .expect(303);
}

async function addGithubProvider(agent: Agent, id = 'gh'): Promise<void> {
  await agent.get(`/-/config/identity?add=${id}&kind=github`).expect(303);
  const draft = await agent.get(`/-/config/identity/${id}?kind=github`).expect(200);
  await agent
    .post(`/-/config/identity/${id}?kind=github`)
    .send({
      ...formBody(draft.text),
      // Credentials typed in, not an App created from a manifest
      [`choice:auth.providers.${id}.app`]: 'manual',
      // The fake IdP answers as a GitHub Enterprise Server under this base
      [`auth.providers.${id}.base_url`]: idp.issuer,
      [`auth.providers.${id}.client_id`]: GITHUB_CLIENT_ID,
      [`auth.providers.${id}.client_secret`]: 'not-a-real-secret',
      intent: 'apply',
    })
    .expect(303);
}

async function addMagicLink(agent: Agent, id = 'links'): Promise<void> {
  await agent.get(`/-/config/identity?add=${id}&kind=magic-link`).expect(303);
  const draft = await agent.get(`/-/config/identity/${id}?kind=magic-link`).expect(200);
  await agent
    .post(`/-/config/identity/${id}?kind=magic-link`)
    .send({ ...formBody(draft.text), intent: 'apply' })
    .expect(303);
}

async function addMailTransport(agent: Agent): Promise<request.Response> {
  const page = await agent.get('/-/config/mail').expect(200);
  return agent
    .post('/-/config/mail')
    .send({
      ...formBody(page.text),
      'mail.host': 'smtp.idp.test',
      'mail.from': 'speicher@idp.test',
      intent: 'apply',
    })
    .expect(303);
}

async function addSource(agent: Agent, id = 'docs'): Promise<request.Response> {
  await agent.get(`/-/config/sources?add=${id}&kind=git`).expect(303);
  const draft = await agent.get(`/-/config/sources/${id}?kind=git`).expect(200);
  return agent
    .post(`/-/config/sources/${id}?kind=git`)
    .send({
      ...formBody(draft.text),
      [`forges.${id}.repos.0.id`]: 'handbook',
      [`forges.${id}.repos.0.url`]: 'https://git.idp.test/handbook/handbook.git',
      [`forges.${id}.repos.0.token`]: 'not-a-real-token',
      intent: 'apply',
    })
    .expect(303);
}

async function prove(agent: Agent): Promise<request.Response> {
  await agent.post('/-/setup/prove').send({ provider: 'wizard' }).expect(302);
  const flow = await LoginFlow.findOne({ order: [['created_at', 'DESC']] });
  return agent.get(`/api/auth/callback?code=${flow?.nonce}&state=${flow?.state}`);
}

/** The page's CSP form-action directive */
const formAction = (page: request.Response) =>
  String(page.headers['content-security-policy'])
    .split('; ')
    .find((directive) => directive.startsWith('form-action'));

/** Where the guide bar leads from the overview, and what its button says */
const start = (html: string) =>
  /href="([^"]+)" data-spr-guide-next>(Start|Continue setup)</.exec(html)?.slice(1, 3) ?? [];

/** Where the guide bar's button leads, or null when the bar shows none */
const next = (html: string) => /href="([^"]+)" data-spr-guide-next>/.exec(html)?.[1] ?? null;

/** A cell of a repository's row on the repository step */
const cell = (html: string, repository: string, name: 'file' | 'sync' | 'readable') => {
  const row =
    new RegExp(`<tr [^>]*data-spr-repo-row="${repository}"[\\s\\S]*?</tr>`).exec(html)?.[0] ?? '';
  return new RegExp(`data-spr-cell="${name}">([\\s\\S]*?)</td>`).exec(row)?.[1] ?? '';
};

/** Makes the first administrator, as the fake IdP signs them in, the one member of a group */
async function joinGroup(name: string): Promise<void> {
  const doc = loadDocument((await getNewestConfigVersion(harness.tenantId))!.yaml);
  doc.setIn(['groups', name], doc.createNode([{ provider: 'wizard', email: 'someone@idp.test' }]));
  await saveInstanceConfig(harness.tenantId, doc.toString(), { origin: 'setup' });
  await app.get(ConfigWatcher).refresh();
}

/** Which next step the repositories page shows, or null when it shows none */
const fixOf = (html: string) => /data-spr-setup-fix="([^"]+)"/.exec(html)?.[1] ?? null;

/** Whether the guide bar's button completes the setup */
const completes = (html: string) => html.includes('action="/-/setup/complete" data-spr-guide-next');

describe('the first run', () => {
  it('goes from a claim to a proved administrator, typing no identity claim', async () => {
    const agent = await claim();

    const before = await agent.get('/-/setup').expect(200);
    expect(start(before.text)).toEqual(['/-/config/identity', 'Start']);
    expect(await setup.showsClaimPage(harness.tenantId, state())).toBe(true);

    await addProvider(agent);
    const v1 = await getNewestConfigVersion(harness.tenantId);
    expect(v1?.version).toBe(1);
    expect(v1?.origin).toBe('setup');
    expect(v1?.applied_by).toBeNull();

    const middle = await agent.get('/-/setup').expect(200);
    expect(start(middle.text)).toEqual(['/-/setup/administrator', 'Continue setup']);

    const done = await prove(agent);
    expect(done.status).toBe(302);
    expect(done.headers.location).toBe('/-/setup');

    const v2 = await getNewestConfigVersion(harness.tenantId);
    expect(v2?.version).toBe(2);
    expect(v2?.origin).toBe('setup');
    expect(v2?.applied_by).toBeNull();
    expect(loadInstanceConfig(v2?.yaml as string).raw.admins?.users).toEqual([
      {
        provider: 'wizard',
        subject: 'subject-from-the-idp',
        note: 'First administrator: someone@idp.test',
      },
    ]);

    expect(await setup.claimWindowOpen(harness.tenantId)).toBe(false);
    expect(await setup.showsClaimPage(harness.tenantId, state())).toBe(false);

    await agent.get('/-/status').expect(200);
    // The setup goes on with the groups, now as the administrator
    const onward = await agent.get('/-/setup').expect(200);
    expect(start(onward.text)).toEqual(['/-/config/groups', 'Continue setup']);
  });

  it('welcomes to the setup, and opens the add modal or the form for a kind', async () => {
    const agent = await claim();

    const page = await agent.get('/-/setup').expect(200);
    expect(page.text).not.toContain('spr-account');
    expect(page.text).not.toContain('spr-search');
    expect(page.text).not.toContain('spr-signin');
    expect(page.text).toContain('class="spr-welcome"');
    // No kind tiles and no step cards: the guide bar is the way in
    expect(page.text).not.toContain('spr-setup-kinds');
    expect(page.text).not.toContain('data-spr-step=');
    expect(page.text).toContain('class="spr-guide"');

    // A kind set up from the add modal opens it; any other lands on its form
    const github = await agent.get('/-/config/identity?kind=github').expect(200);
    expect(github.text).toMatch(/<details class="spr-modal[^"]*" open>/);
    const identity = await agent.get('/-/config/identity?kind=oidc').expect(303);
    expect(identity.headers.location).toBe('/-/config/identity/oidc?kind=oidc');

    const nonsense = await agent.get('/-/config/identity?kind=ldap').expect(200);
    expect(nonsense.text).not.toMatch(/<details class="spr-modal" open>/);
  });

  it('lands a source kind on its form too, which is a table and not tiles', async () => {
    const agent = await claim();
    const sources = await agent.get('/-/config/sources?kind=git').expect(303);
    expect(sources.headers.location).toBe('/-/config/sources/git?kind=git');
  });

  it('walks the steps in order, the login before the groups it needs', async () => {
    const agent = await claim();
    const page = await agent.get('/-/config').expect(200);
    const rail = page.text.slice(page.text.indexOf('class="spr-progress"'));
    const order = [
      '/-/config/identity',
      '/-/setup/administrator',
      '/-/config/groups',
      '/-/config/sources',
      '/-/repositories',
    ].map((href) => rail.indexOf(`href="${href}"`));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    await agent.get('/-/config/identity').expect(200);
    await agent.get('/-/config/sources').expect(200);
  });

  it('puts the relay ahead of the provider that needs it, and leads on to that provider', async () => {
    const agent = await claim();

    const fresh = await agent.get('/-/config').expect(200);
    const rail = fresh.text.slice(
      fresh.text.indexOf('class="spr-progress"'),
      fresh.text.indexOf('</nav>', fresh.text.indexOf('class="spr-progress"')),
    );
    expect(rail).not.toContain('href="/-/config/mail"');

    const relay = await agent.get('/-/config/mail').expect(200);
    expect(relay.text).toMatch(/aria-current="step"[\s\S]*?Mail transport/);
    expect(relay.text).toMatch(/href="\/-\/config\/mail" aria-current="page"/);
    expect(relay.text.indexOf('/-/config/mail')).toBeLessThan(
      relay.text.indexOf('/-/config/identity'),
    );
    expect(next(relay.text)).toBeNull();

    const stored = await addMailTransport(agent);
    expect(stored.headers.location).toMatch(/^\/-\/config\/mail\?saved=\d+$/);
    const settled = await agent.get(stored.headers.location).expect(200);
    expect(next(settled.text)).toBe('/-/config/identity?kind=magic-link');

    await addMagicLink(agent);
    const after = await agent.get('/-/config').expect(200);
    expect(after.text).toMatch(
      /spr-progress-step spr-progress-done[\s\S]*?Mail transport[\s\S]*?>done</,
    );
    // All settings is no step's page, so the rail marks none
    expect(after.text).not.toContain('aria-current="step"');
  });

  it('refuses that provider without a relay, which is why the step exists', async () => {
    const agent = await claim();
    await agent.get('/-/config/identity?add=links&kind=magic-link').expect(303);
    const draft = await agent.get('/-/config/identity/links?kind=magic-link').expect(200);
    const refused = await agent
      .post('/-/config/identity/links?kind=magic-link')
      .send({ ...formBody(draft.text), intent: 'apply' })
      .expect(400);
    expect(refused.text).toContain('/-/config/mail');
  });

  it('stays on a saved step, and offers Next once it is done', async () => {
    const agent = await claim();

    await agent.get('/-/config/identity?add=wizard&kind=oidc').expect(303);
    const draft = await agent.get('/-/config/identity/wizard?kind=oidc').expect(200);
    // Not done yet, so the bar has no Next
    expect(next(draft.text)).toBeNull();
    expect(draft.text).toContain('Step 1 of 5: <strong>Identity provider</strong>');
    const first = await agent
      .post('/-/config/identity/wizard?kind=oidc')
      .send({
        ...formBody(draft.text),
        'auth.providers.wizard.issuer': idp.issuer,
        'auth.providers.wizard.client_id': CLIENT_ID,
        intent: 'apply',
      })
      .expect(303);
    expect(first.headers.location).toMatch(/^\/-\/config\/identity\/wizard\?saved=\d+$/);
    const saved = await agent.get(first.headers.location).expect(200);
    expect(next(saved.text)).toBe('/-/setup/administrator');
    // The first provider is the default, on screen while it is made and in what is stored
    expect(draft.text).toMatch(/name="auth\.default_provider"[^>]*checked/);
    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toContain(
      'default_provider: wizard',
    );

    const again = await agent.get('/-/config/identity/wizard').expect(200);
    const edited = await agent
      .post('/-/config/identity/wizard')
      .send({
        ...formBody(again.text),
        'auth.providers.wizard.client_id': 'a-different-client',
        intent: 'apply',
      })
      .expect(303);
    expect(edited.headers.location).toMatch(/^\/-\/config\/identity\/wizard\?saved=\d+$/);

    const source = await addSource(agent);
    expect(source.headers.location).toMatch(/^\/-\/config\/sources\/docs\?saved=\d+$/);
    // The first source is the primary, written down, so a second one cannot move its URLs
    const stored = loadDocument((await getNewestConfigVersion(harness.tenantId))?.yaml ?? '');
    expect(stored.getIn(['forges', 'docs', 'primary'])).toBe(true);

    // Nobody is signed in to name yet, and it did not come from the file either
    const sources = await agent.get('/-/config/sources').expect(200);
    expect(sources.text).toMatch(/docs<\/a>[\s\S]*?spr-cell-quiet">setup</);
  });

  it('leaves an ordinary administrator where they saved', async () => {
    const agent = await claim();
    await addProvider(agent);
    await prove(agent);

    const page = await agent.get('/-/config/identity/wizard').expect(200);
    const saved = await agent
      .post('/-/config/identity/wizard')
      .send({
        ...formBody(page.text),
        'auth.providers.wizard.client_id': 'still-editing',
        intent: 'apply',
      })
      .expect(303);
    expect(saved.headers.location).toMatch(/^\/-\/config\/identity\/wizard\?saved=\d+$/);
  });

  it('gives the login a page of its own, which the overview links to', async () => {
    const agent = await claim();
    await addProvider(agent);

    const overview = await agent.get('/-/setup').expect(200);
    expect(start(overview.text)[0]).toBe('/-/setup/administrator');
    expect(overview.text).not.toContain('action="/-/setup/prove"');

    const page = await agent.get('/-/setup/administrator').expect(200);
    expect(page.text).toContain('action="/-/setup/prove"');
    expect(page.text).toContain('spr-progress');
    expect(page.text).toMatch(/aria-current="step"[\s\S]*?Administrator/);
    // In the header beside the brand, not in the content card
    expect(page.text).toMatch(
      /<header class="spr-header">[\s\S]*?<nav class="spr-progress"[\s\S]*?<\/header>/,
    );
    expect(page.text.slice(page.text.indexOf('<main'))).not.toContain('class="spr-progress"');
  });

  it('lets the login form redirect to the provider, which Safari checks against form-action', async () => {
    const agent = await claim();
    await addProvider(agent);

    const page = await agent.get('/-/setup/administrator').expect(200);
    const formAction = (page.headers['content-security-policy'] ?? '')
      .split(';')
      .map((part: string) => part.trim())
      .find((part: string) => part.startsWith('form-action '));
    expect(formAction?.split(/\s+/).slice(1)).toEqual(["'self'", new URL(idp.issuer).origin]);
  });

  it('sends a claim session back to the wizard from anywhere else', async () => {
    const agent = await claim();

    for (const path of ['/', '/-/status', '/-/graph', '/-/dead-jobs', '/handbook/anything']) {
      const response = await agent.get(path);
      expect([response.status, response.headers.location]).toEqual([303, '/-/setup']);
    }
  });

  it('leaves reachable everything a page and the flow are made of', async () => {
    const agent = await claim();

    await agent.get('/-/setup').expect(200);
    await agent.get('/-/config').expect(200);
    await agent.get('/-/config/identity').expect(200);
    await agent.get('/-/healthz').expect(200);
    await agent.get('/-/readyz').expect(200);
    await agent.get('/api/setup/claim').expect(200);
    const callback = await agent.get('/api/auth/callback');
    expect(callback.status).not.toBe(303);
  });

  it('does not steer a reader, or an administrator who is not in a flow', async () => {
    const stranger = request.agent(app.getHttpServer());
    const denied = await stranger.get('/-/status');
    expect([denied.status, denied.headers.location]).toEqual([303, '/']);
    await stranger.get('/').expect(200);

    const agent = await claim();
    await addProvider(agent);
    expect(
      await runCli(['admin', 'add', '--provider', 'wizard', '--subject', 'x', '--note', 'y']),
    ).toBe(0);
    config.adopt(loadInstanceConfig((await getNewestConfigVersion(harness.tenantId))!.yaml));
    await agent.get('/-/status').expect(200);
  });

  it('shows a claim session how far along it is, and nobody else', async () => {
    const agent = await claim();
    await addProvider(agent);

    const config = await agent.get('/-/config').expect(200);
    expect(config.text).toContain('spr-progress');

    expect(config.text).toMatch(
      /spr-progress-step spr-progress-done[\s\S]*?Identity provider[\s\S]*?>done</,
    );
    expect(config.text).not.toContain('aria-current="step"');
    expect(config.text).toContain('href="/-/config/identity"');
    expect(config.text).toContain('href="/-/config/sources"');

    // The overview shows the steps too, with nothing marked as the page
    expect((await agent.get('/-/setup').expect(200)).text).toContain('spr-progress');

    expect(config.text).not.toContain('/-/graph');

    const identity = await agent.get('/-/config/identity').expect(200);
    expect(identity.text).not.toContain('spr-crumbs');

    expect(identity.text).toMatch(
      /spr-progress-step spr-progress-done spr-progress-current[\s\S]*?Identity provider/,
    );
    expect(identity.text.match(/aria-current="step"/g)).toHaveLength(1);
    expect(identity.text).toMatch(/href="\/-\/config\/identity" aria-current="page"/);
  });

  it('keeps guiding the first administrator, until they complete the setup', async () => {
    const agent = await claim();
    await addProvider(agent);
    await prove(agent);

    // Signed in as the administrator, no longer a claim session, and still guided
    const guided = await agent.get('/-/config').expect(200);
    expect(guided.text).toContain('spr-progress');
    expect(guided.text).toContain('class="spr-guide"');
    expect(next(guided.text)).toBe('/-/config/groups');
    expect(guided.text).toContain('href="/-/setup/later"');
    expect((await agent.get('/-/config/identity').expect(200)).text).not.toContain('spr-crumbs');

    // Not before it is complete: refused while no page is readable
    const early = await agent.post('/-/setup/complete').expect(303);
    expect(early.headers.location).toBe('/-/repositories');
    expect(next((await agent.get('/-/config').expect(200)).text)).toBe('/-/config/groups');

    // Readable now, which offers to complete the setup, and only that ends it
    await grantHandbook();
    const readable = await agent.get('/-/config').expect(200);
    expect(readable.text).toContain('class="spr-guide"');
    expect(completes(readable.text)).toBe(true);

    const completed = await agent.post('/-/setup/complete').expect(303);
    expect(completed.headers.location).toBe('/');
    const over = await agent.get('/-/config').expect(200);
    expect(over.text).not.toContain('spr-progress');
    expect(over.text).not.toContain('class="spr-guide"');
    expect(over.text).not.toContain('/-/setup"');
    expect((await agent.get('/-/config/identity').expect(200)).text).toContain('spr-crumbs');
    expect((await agent.get('/-/setup').expect(200)).text).toContain(
      'The setup of this instance is complete.',
    );

    // Done for good: a page that is no longer readable does not reopen it
    await getSequelize().query(`UPDATE documents SET effective_principals = '{}'`, {
      type: QueryTypes.UPDATE,
    });
    expect((await agent.get('/-/config').expect(200)).text).not.toContain('class="spr-guide"');
  });

  it('can be left for later by the administrator, and taken up again from the overview', async () => {
    const agent = await claim();
    await addProvider(agent);
    await prove(agent);

    const left = await agent.get('/-/setup/later').expect(303);
    expect(left.headers.location).toBe('/-/config');
    const later = await agent.get('/-/config').expect(200);
    expect(later.text).not.toContain('spr-progress');
    expect(later.text).toContain('The setup of this instance is not finished yet.');
    expect(next(later.text)).toBe('/-/setup');

    await agent.get('/-/setup').expect(200);
    const resumed = await agent.get('/-/config').expect(200);
    expect(resumed.text).toContain('spr-progress');
    expect(next(resumed.text)).toBe('/-/config/groups');
  });

  it('cannot be left for later by a claim session, which has no administrator to leave it to', async () => {
    const agent = await claim();
    const page = await agent.get('/-/config').expect(200);
    expect(page.text).not.toContain('/-/setup/later');
    await agent.get('/-/setup/later').expect(404);
  });

  it('resumes after the tab is closed, through a fresh claim', async () => {
    const first = await claim();
    await addProvider(first);

    const second = await claim();
    const page = await second.get('/-/setup').expect(200);
    expect(start(page.text)).toEqual(['/-/setup/administrator', 'Continue setup']);

    await prove(second);
    expect(await setup.claimWindowOpen(harness.tenantId)).toBe(false);
  });
});

describe('the walkthrough of a config page', () => {
  const opened = (html: string) =>
    /<details class="spr-modal spr-walkthrough" data-spr-walkthrough open>/.test(html);

  it('explains the identity providers on the first visit, recommending GitHub', async () => {
    const agent = await claim();
    const page = await agent.get('/-/config/identity').expect(200);
    expect(opened(page.text)).toBe(true);
    expect(page.text).toContain('How signing in works');
    expect(page.text).toMatch(
      /GitHub<\/span>\s*<span\s+class="spr-badge spr-badge-ok"[^>]*>recommended/,
    );
    expect(page.text).toContain(
      'Since this is the easiest to set up, we recommend it if you are not setting up Speicher.md for an organization.',
    );
  });

  it('does not open by itself over a modal the address opens', async () => {
    const agent = await claim();
    const page = await agent.get('/-/config/identity?kind=github').expect(200);
    expect(opened(page.text)).toBe(false);
    // Not seen yet, so a plain visit still opens it
    expect(opened((await agent.get('/-/config/identity').expect(200)).text)).toBe(true);
  });

  it('opens by itself the first time the guided setup reaches the groups, and from its link after', async () => {
    const agent = await claim();
    await addProvider(agent);
    await prove(agent);

    const first = await agent.get('/-/config/groups').expect(200);
    expect(opened(first.text)).toBe(true);
    expect(first.text).toContain('How groups work');
    expect(String(first.headers['set-cookie'])).toContain('speicher_walkthrough_groups=1');

    // Seen: shut, and still there to open from the heading
    const again = await agent.get('/-/config/groups').expect(200);
    expect(opened(again.text)).toBe(false);
    // A question mark beside the heading opens it again
    expect(again.text).toContain(
      '<summary class="spr-walkthrough-open" aria-label="How does this work?" title="How does this work?">',
    );
  });

  it('shows the controls it talks about, inert, so nothing in them can be used', async () => {
    const agent = await claim();
    await addProvider(agent);
    const page = await agent.get('/-/config/groups').expect(200);
    const previews = [
      ...page.text.matchAll(/<div class="spr-walkthrough-preview" inert aria-hidden="true">/g),
    ];
    expect(previews).toHaveLength(5);
    // It starts with the file the groups are used in
    expect(page.text.indexOf('What is a .speicher.yaml file?')).toBeLessThan(
      page.text.indexOf('What is a group?'),
    );
    // A group is its rules, any of which lets a person in, and a repository names it by its short id
    expect(page.text).toContain('A group is a list of membership rules');
    expect(page.text).toContain('access: [<mark>engineering</mark>]');
    expect(page.text).toContain('ferdinand.duschka@copetence.de');
    // Outside the page's form, so nothing in them is ever posted
    const form = page.text.indexOf('<form class="spr-config"');
    expect(page.text.indexOf('data-spr-walkthrough')).toBeLessThan(form);
  });

  it('explains the content sources, from what one is to installing the GitHub App', async () => {
    const agent = await claim();
    const page = await agent.get('/-/config/sources').expect(200);
    expect(page.text).toContain('How content sources work');
    const previews = [
      ...page.text.matchAll(/<div class="spr-walkthrough-preview" inert aria-hidden="true">/g),
    ];
    expect(previews).toHaveLength(3);
    expect(page.text.indexOf('What is a content source?')).toBeLessThan(
      page.text.indexOf('Creating the GitHub App'),
    );
    expect(page.text).toContain('Which repositories do you want to sync');
    // GitHub's installation page, in the scheme the browser follows
    expect(page.text).toMatch(
      /<source srcset="\/-\/static\/walkthrough-install-github-app-dark-\w+\.webp" media="\(prefers-color-scheme: dark\)">\s*<img class="spr-walkthrough-screenshot" src="\/-\/static\/walkthrough-install-github-app-light-\w+\.webp"/,
    );
  });

  it('shows the screenshot in the scheme the reader fixed, and only that one', async () => {
    const agent = await claim();
    const page = await agent
      .get('/-/config/sources')
      .set('Cookie', 'speicher_theme=dark')
      .expect(200);
    expect(page.text).toMatch(
      /<img class="spr-walkthrough-screenshot" src="\/-\/static\/walkthrough-install-github-app-dark-\w+\.webp"/,
    );
    expect(page.text).not.toContain('walkthrough-install-github-app-light-');
  });

  it('explains the repositories page on the first visit, from publishing to the sync', async () => {
    const agent = await claim();
    await addProvider(agent);
    await prove(agent);

    const first = await agent.get('/-/repositories').expect(200);
    expect(opened(first.text)).toBe(true);
    expect(first.text).toContain('How repositories are published');
    expect(String(first.headers['set-cookie'])).toContain('speicher_walkthrough_repositories=1');
    const previews = [
      ...first.text.matchAll(/<div class="spr-walkthrough-preview" inert aria-hidden="true">/g),
    ];
    expect(previews).toHaveLength(4);
    expect(first.text).toContain('access: [<mark>sales</mark>]');
    // Beside the heading, as on the config pages
    expect(first.text).toMatch(/Repositories<\/h1>\s*<details class="spr-modal spr-walkthrough"/);

    // Seen: shut, and still there to open
    expect(opened((await agent.get('/-/repositories').expect(200)).text)).toBe(false);
  });

  it('does not open by itself on a page that is no step of a guided setup', async () => {
    const agent = await claim();
    await addProvider(agent);
    await prove(agent);
    await agent.get('/-/setup/later').expect(303);
    const page = await agent.get('/-/config/groups').expect(200);
    expect(opened(page.text)).toBe(false);
  });
});

describe('a group made during the setup', () => {
  async function draftGroup(agent: Agent): Promise<request.Response> {
    await agent.get('/-/config/groups?add=eng').expect(303);
    return agent.get('/-/config/groups/eng').expect(200);
  }

  it('says why it offers no members before there is a provider to take them from', async () => {
    const draft = await draftGroup(await claim());
    expect(draft.text).not.toContain('<span>Add members</span>');
    expect(draft.text).toContain(
      'To add members, first add an <a href="/-/config/identity">identity provider</a>.',
    );
  });

  it('offers to add members once there is a provider', async () => {
    const agent = await claim();
    await addProvider(agent);
    const draft = await draftGroup(agent);
    expect(draft.text).toContain('<span>Add members</span>');
    expect(draft.text).not.toContain('first add an');
  });

  it('is not saved without a member', async () => {
    const agent = await claim();
    await addProvider(agent);
    const draft = await draftGroup(agent);
    const refused = await agent
      .post('/-/config/groups/eng')
      .send({ ...formBody(draft.text), intent: 'apply' })
      .expect(400);
    expect(refused.text).toContain('A group needs at least one member.');
    const stored = loadDocument((await getNewestConfigVersion(harness.tenantId))!.yaml);
    expect(stored.hasIn(['groups', 'eng'])).toBe(false);
  });

  it('finishes the groups step once a group has a member, not when one only exists', async () => {
    const agent = await claim();
    await addProvider(agent);
    await prove(agent);
    const withGroup = async (members: unknown[]) => {
      const doc = loadDocument((await getNewestConfigVersion(harness.tenantId))!.yaml);
      doc.setIn(['groups', 'eng'], doc.createNode(members));
      await saveInstanceConfig(harness.tenantId, doc.toString(), { origin: 'setup' });
      await app.get(ConfigWatcher).refresh();
      return agent.get('/-/config/groups').expect(200);
    };

    expect(next((await withGroup([])).text)).toBeNull();
    expect(next((await withGroup([{ provider: 'wizard', email: 'ada@idp.test' }])).text)).toBe(
      '/-/config/sources?kind=github',
    );
  });
});

describe('the repository step', () => {
  it('shows only the step before the repositories while the administrator is in no group', async () => {
    const agent = await claim();
    await addProvider(agent);
    await prove(agent);

    const page = await agent.get('/-/repositories').expect(200);
    // One step, with the provider the administrator signed in with, and the way to do it
    expect(fixOf(page.text)).toBe('group');
    expect(page.text).toContain('You are signed in as someone@idp.test with wizard');
    expect(page.text).toMatch(
      /<a class="spr-ready-action spr-ready-next" href="\/-\/config\/groups">Open groups/,
    );
    // The table waits until it is of use
    expect(page.text).toMatch(/data-spr-repository-step[^>]* hidden>/);
    expect(page.text).toContain('data-spr-setup-fix-region data-spr-blocked>');
    expect(next(page.text)).toBeNull();
    expect(completes(page.text)).toBe(false);
  });

  it('says the one thing that is left until the administrator can read a repository', async () => {
    const agent = await claim();
    await addProvider(agent);
    await prove(agent);
    await joinGroup('staff');

    const page = await agent.get('/-/repositories').expect(200);
    // A row per synced repository, as the sync status has it, and readable by nobody yet
    expect(cell(page.text, 'copetence/handbook', 'sync')).toContain('>ok<');
    expect(cell(page.text, 'copetence/handbook', 'file')).toContain('>present<');
    expect(cell(page.text, 'copetence/handbook', 'readable')).toContain('–');
    expect(page.text).toContain('href="/-/status/copetence/handbook"');
    expect(page.text).not.toMatch(/data-spr-repository-step[^>]* hidden>/);
    // Synced with a file that grants none of the administrator's groups
    expect(fixOf(page.text)).toBe('no-grant');
    expect(page.text).toContain('Add <code>staff</code> to the groups under <code>access</code>.');

    await grantHandbook();
    const readable = await agent.get('/-/repositories').expect(200);
    // The table stays, the handbook readable now, and the bar completes the setup
    expect(cell(readable.text, 'copetence/handbook', 'readable')).toContain('>yes<');
    expect(cell(readable.text, 'copetence/fieldkit', 'readable')).toContain('–');
    // No step: the bar offers to complete the setup, and the refresh stops
    expect(fixOf(readable.text)).toBeNull();
    expect(readable.text).toContain('data-spr-setup-fix-region data-spr-readable>');
    expect(completes(readable.text)).toBe(true);
    const [row] = await getSequelize().query<{ completed: boolean }>(
      `SELECT setup_completed_at IS NOT NULL AS completed FROM tenants WHERE id = :id`,
      { type: QueryTypes.SELECT, replacements: { id: harness.tenantId } },
    );
    expect(row.completed).toBe(false);

    await agent.post('/-/setup/complete').expect(303);
    const finished = await agent.get('/-/repositories').expect(200);
    // A page of the configuration now, which says nothing about the setup
    expect(finished.text).not.toContain('The setup of this instance is complete.');
    expect(finished.text).not.toContain('spr-section-status');
    expect(cell(finished.text, 'copetence/handbook', 'readable')).toContain('>yes<');
    expect(finished.text).not.toContain('class="spr-guide"');
  });

  it('shows a repository that is queued for a sync, and one that is being synced', async () => {
    const agent = await claim();
    await addProvider(agent);
    await prove(agent);

    const db = getSequelize();
    await db.query(
      `INSERT INTO jobs (tenant_id, kind, payload, status, run_after, locked_until)
       VALUES (:tenantId, 'sync-repo-content', CAST(:queued AS jsonb), 'pending', now(), NULL),
              (:tenantId, 'sync-repo-content', CAST(:running AS jsonb), 'running', now(), now() + interval '1 minute')`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          tenantId: harness.tenantId,
          queued: JSON.stringify({ repoId: harness.repos.handbook }),
          running: JSON.stringify({ repoId: harness.repos.specs }),
        },
      },
    );
    try {
      const page = await agent.get('/-/repositories').expect(200);
      // As the sync status page shows it
      expect(cell(page.text, 'copetence/handbook', 'sync')).toContain('queued</span>');
      expect(cell(page.text, 'northwind-engineering/specs', 'sync')).toContain('syncing</span>');
      expect(cell(page.text, 'copetence/fieldkit', 'sync')).not.toContain('spr-activity');
      // Busy, so the page asks again sooner
      expect(page.text).toMatch(/data-spr-repository-step data-spr-busy/);
    } finally {
      await db.query(`DELETE FROM jobs`, { type: QueryTypes.DELETE });
    }
  });

  it('is not reachable by anybody who did not claim this instance', async () => {
    await request(app.getHttpServer()).get('/-/repositories').expect(303);
  });

  it('narrows the table on the server, so the filter box works with no script', async () => {
    const agent = await claim();
    await addProvider(agent);
    await prove(agent);

    const page = await agent.get('/-/repositories').query({ q: 'Hand' }).expect(200);
    expect(page.text).toMatch(/<input id="filter-repositories"[^>]*value="Hand"/);
    expect(page.text).toContain('data-spr-repo-row="copetence/handbook"');
    expect(page.text).not.toContain('data-spr-repo-row="copetence/fieldkit"');

    const none = await agent.get('/-/repositories').query({ q: 'nothing-matches' }).expect(200);
    expect(none.text).not.toContain('data-spr-repo-row=');
    expect(none.text).toMatch(/data-spr-empty="filtered">\s*No repository matches/);
  });

  it('is a page of the configuration once the setup is complete', async () => {
    const agent = await claim();
    await addProvider(agent);
    await prove(agent);
    await grantHandbook();
    await agent.post('/-/setup/complete').expect(303);

    const page = await agent.get('/-/repositories').expect(200);
    expect(page.text).toContain('<h1 class="spr-titled">');
    expect(page.text).toMatch(/href="\/-\/repositories" aria-current="page"/);
    // Under Configuration, after the content sources
    const nav = page.text.slice(page.text.indexOf('data-spr-fold="config"'));
    expect(nav.indexOf('href="/-/config/sources"')).toBeGreaterThan(-1);
    expect(nav.indexOf('href="/-/repositories"')).toBeGreaterThan(
      nav.indexOf('href="/-/config/sources"'),
    );
    expect(page.text).not.toContain('class="spr-guide"');
    // No step any more: the administrator's groups, as a note
    expect(page.text).toMatch(
      /<div class="spr-setup-groups" data-spr-setup-region="group">\s*<p class="spr-note[^>]*>[\s\S]*?You are signed in as/,
    );
    expect(page.text).not.toContain('Your groups');
  });
});

describe('the proving login through GitHub', () => {
  it('names the GitHub account the first administrator, by its numeric id', async () => {
    const agent = await claim();
    await addGithubProvider(agent);

    const page = await agent.get('/-/setup/administrator').expect(200);
    expect(page.text).toContain('action="/-/setup/prove"');
    expect(page.text).toContain('value="gh"');
    // The browser holds the POST's redirect to GitHub to this directive
    expect(formAction(page)).toBe(`form-action 'self' ${idp.issuer}`);

    const started = await agent.post('/-/setup/prove').send({ provider: 'gh' }).expect(302);
    const authorize = new URL(started.headers.location);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${idp.issuer}/login/oauth/authorize`);
    expect(authorize.searchParams.get('redirect_uri')).toMatch(/\/api\/auth\/github\/callback$/);

    const flow = await LoginFlow.findOne({ order: [['created_at', 'DESC']] });
    expect(flow?.provider).toBe('gh');
    expect(flow?.names_first_admin).toBe(true);

    const done = await agent
      .get(`/api/auth/github/callback?code=from-github&state=${flow?.state}`)
      .expect(302);
    expect(done.headers.location).toBe('/-/setup');

    const newest = await getNewestConfigVersion(harness.tenantId);
    expect(loadInstanceConfig(newest!.yaml).raw.admins?.users).toEqual([
      {
        provider: 'gh',
        subject: '4242',
        note: 'First administrator: octo@idp.test',
      },
    ]);
    expect(await setup.claimWindowOpen(harness.tenantId)).toBe(false);
  });

  it('offers OIDC and GitHub side by side, each starting its own flow', async () => {
    const agent = await claim();
    await addProvider(agent);
    await addGithubProvider(agent);

    const page = await agent.get('/-/setup/administrator').expect(200);
    expect(page.text).toContain('id="spr-prove-provider"');
    // The fake IdP serves both kinds from one origin, so it appears once
    expect(formAction(page)).toBe(`form-action 'self' ${idp.issuer}`);
    expect(page.text).toContain('value="wizard"');
    expect(page.text).toContain('value="gh"');

    const oidc = await agent.post('/-/setup/prove').send({ provider: 'wizard' }).expect(302);
    expect(oidc.headers.location.startsWith(`${idp.issuer}/authorize`)).toBe(true);
    const github = await agent.post('/-/setup/prove').send({ provider: 'gh' }).expect(302);
    expect(github.headers.location.startsWith(`${idp.issuer}/login/oauth/authorize`)).toBe(true);
  });
});

describe('the first administrator named by setting up a GitHub provider', () => {
  /** Gives the provider the App this instance would have created on the organization acme */
  async function storeApp(id = 'gh'): Promise<void> {
    const doc = loadDocument((await getNewestConfigVersion(harness.tenantId))!.yaml);
    doc.setIn(
      ['auth', 'providers', id, 'app'],
      doc.createNode({
        client_id: GITHUB_CLIENT_ID,
        slug: 'speicher-gh',
        owner_account: 'acme',
        owner_is_organization: true,
        public: false,
      }),
    );
    await saveInstanceConfig(harness.tenantId, doc.toString(), { origin: 'setup' });
    await app.get(ConfigWatcher).refresh();
  }

  it('names the person who installs an organization’s App, and goes on with the setup', async () => {
    const agent = await claim();
    await addGithubProvider(agent);
    await storeApp();

    const install = await agent.get('/-/config/identity/gh/install').expect(303);
    expect(install.headers.location).toBe(
      `${idp.issuer}/github-apps/speicher-gh/installations/new`,
    );

    // GitHub signs the person in as they install the App, and sends them back with no state
    const back = await agent
      .get('/api/auth/github/callback?code=from-github&installation_id=99&setup_action=install')
      .expect(302);
    expect(back.headers.location).toBe(
      '/-/config/identity/gh/ready?setup_action=install&installation_id=99&first_admin=1',
    );
    const newest = await getNewestConfigVersion(harness.tenantId);
    expect(loadInstanceConfig(newest!.yaml).raw.admins?.users).toEqual([
      { provider: 'gh', subject: '4242', note: 'First administrator: octo@idp.test' },
    ]);
    expect(await setup.claimWindowOpen(harness.tenantId)).toBe(false);

    const page = await agent.get(back.headers.location).expect(200);
    expect(page.text).toContain('You are signed in as the first administrator');
    // The setup goes on with its next step, the groups
    expect(page.text).toMatch(/href="\/-\/config\/groups" data-spr-ready-primary>Continue/);
  });

  it('signs the creator of a personal account’s App straight in, as it has nothing to install', async () => {
    const agent = await claim();
    const created = await agent
      .post('/-/config/identity/-/create')
      .type('form')
      .send({ kind: 'github', add: 'gh', 'quick:github:audience': 'me' })
      .expect(303);
    const handoff = await agent.get(created.headers.location).expect(200);
    const action = /<form method="post" action="([^"]+)"/.exec(handoff.text)?.[1] ?? '';
    const state = new URL(action.replace(/&amp;/g, '&')).searchParams.get('state');

    const back = await agent
      .get(`/-/config/identity/gh/github-app/manifest/callback?code=c&state=${state}`)
      .expect(302);
    const authorize = new URL(back.headers.location);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      'https://github.com/login/oauth/authorize',
    );
    expect(authorize.searchParams.get('client_id')).toBe('Iv1.mine');

    const flow = await LoginFlow.findOne({ order: [['created_at', 'DESC']] });
    expect(flow?.provider).toBe('gh');
    expect(flow?.names_first_admin).toBe(true);
    expect(flow?.redirect_to).toBe('/-/config/identity/gh/ready?first_admin=1');
  });
});

describe('the proving login through a magic link', () => {
  async function askForLink(agent: Agent, email: string): Promise<string> {
    const answered = await agent
      .post('/-/setup/prove')
      .send({ provider: 'links', email })
      .expect(200);
    expect(answered.text).toContain(`A sign-in link was sent to ${email}.`);
    return /token=([^\s]+)/.exec(sent[sent.length - 1].text)?.[1] ?? '';
  }

  it('names the address the first administrator, by its lowercase email', async () => {
    const agent = await claim();
    await addMailTransport(agent);
    await addMagicLink(agent);

    const page = await agent.get('/-/setup/administrator').expect(200);
    expect(page.text).toContain('action="/-/setup/prove"');
    expect(page.text).toContain('value="links"');
    expect(page.text).toContain('type="email" name="email"');
    // The answer is this page, not a redirect elsewhere
    expect(formAction(page)).toBe(`form-action 'self'`);

    const token = await askForLink(agent, 'Ada@Example.test');
    expect(sent.map(({ to, subject }) => [to, subject])).toEqual([
      ['ada@example.test', 'Become the Speicher administrator'],
    ]);

    const done = await agent.get(`/api/auth/magic/callback?token=${token}`).expect(302);
    expect(done.headers.location).toBe('/-/setup');

    const newest = await getNewestConfigVersion(harness.tenantId);
    expect(loadInstanceConfig(newest!.yaml).raw.admins?.users).toEqual([
      {
        provider: 'links',
        subject: 'ada@example.test',
        note: 'First administrator: ada@example.test',
      },
    ]);
    expect(await setup.claimWindowOpen(harness.tenantId)).toBe(false);
  });

  it('is offered beside an OIDC provider, each in its own form', async () => {
    const agent = await claim();
    await addProvider(agent);
    await addMailTransport(agent);
    await addMagicLink(agent);

    const page = await agent.get('/-/setup/administrator').expect(200);
    expect(page.text).toContain('value="wizard"');
    expect(page.text).toContain('value="links"');
    expect(formAction(page)).toBe(`form-action 'self' ${idp.issuer}`);
  });

  it('only works in the browser that claimed the instance', async () => {
    const agent = await claim();
    await addMailTransport(agent);
    await addMagicLink(agent);
    const token = await askForLink(agent, 'ada@example.test');

    await browser().get(`/api/auth/magic/callback?token=${token}`).expect(400);
    expect(
      loadInstanceConfig((await getNewestConfigVersion(harness.tenantId))!.yaml).raw.admins,
    ).toBeUndefined();
  });

  it('writes nothing when the instance got an administrator in the meantime', async () => {
    const agent = await claim();
    await addMailTransport(agent);
    await addMagicLink(agent);
    const token = await askForLink(agent, 'ada@example.test');

    expect(
      await runCli(['admin', 'add', '--provider', 'links', '--email', 'zoe@example.test']),
    ).toBe(0);
    await config.adopt(loadInstanceConfig((await getNewestConfigVersion(harness.tenantId))!.yaml));

    await agent.get(`/api/auth/magic/callback?token=${token}`).expect(302);
    expect(
      loadInstanceConfig((await getNewestConfigVersion(harness.tenantId))!.yaml).raw.admins?.users,
    ).toEqual([expect.objectContaining({ email: 'zoe@example.test' })]);
  });

  it('is not something an ordinary magic-link request can turn into', async () => {
    const agent = await claim();
    await addMailTransport(agent);
    await addMagicLink(agent);

    // Before an administrator exists nobody has a grant, so nothing is sent
    await agent.post('/api/auth/magic').send({ provider: 'links', email: 'ada@example.test' });
    expect(sent).toEqual([]);
  });

  it('is refused to anybody who did not claim this instance', async () => {
    const agent = await claim();
    await addMailTransport(agent);
    await addMagicLink(agent);

    await browser()
      .post('/-/setup/prove')
      .send({ provider: 'links', email: 'mallory@example.test' })
      .expect(404);
    expect(sent).toEqual([]);
  });
});

describe('the proving login behind a proxy', () => {
  /*
    The request reaches the app as 127.0.0.1, as it would through a proxy that
    forwards no Host. The redirect_uri must still be the declared public address,
    or the token exchange, which uses it, would not match the authorize request.
  */
  it.each([
    ['an OIDC provider', 'wizard', '/api/auth/callback'],
    ['a GitHub provider', 'gh', '/api/auth/github/callback'],
  ])('sends SPEICHER_PUBLIC_URL as the redirect_uri for %s', async (_, id, path) => {
    process.env.SPEICHER_PUBLIC_URL = 'https://docs.example.test/';
    const agent = await claim();
    if (id === 'gh') await addGithubProvider(agent, id);
    else await addProvider(agent, id);

    const started = await agent.post('/-/setup/prove').send({ provider: id }).expect(302);
    expect(new URL(started.headers.location).searchParams.get('redirect_uri')).toBe(
      `https://docs.example.test${path}`,
    );
  });
});

describe('what the proving login refuses', () => {
  it('writes nothing when the instance already has an administrator', async () => {
    const agent = await claim();
    await addProvider(agent);

    await agent.post('/-/setup/prove').send({ provider: 'wizard' }).expect(302);
    const flow = await LoginFlow.findOne({ order: [['created_at', 'DESC']] });
    expect(flow?.names_first_admin).toBe(true);

    expect(
      await runCli([
        'admin',
        'add',
        '--provider',
        'wizard',
        '--subject',
        'somebody',
        '--note',
        'x',
      ]),
    ).toBe(0);
    await config.adopt(loadInstanceConfig((await getNewestConfigVersion(harness.tenantId))!.yaml));

    await agent.get(`/api/auth/callback?code=${flow?.nonce}&state=${flow?.state}`).expect(302);

    const newest = await getNewestConfigVersion(harness.tenantId);
    expect(loadInstanceConfig(newest!.yaml).raw.admins?.users).toHaveLength(1);
  });

  it('is not something an ordinary login can turn into', async () => {
    const agent = await claim();
    await addProvider(agent);

    await agent.get('/api/auth/login?provider=wizard&redirect_to=/').expect(302);
    const flow = await LoginFlow.findOne({ order: [['created_at', 'DESC']] });
    expect(flow?.names_first_admin).toBe(false);

    await agent.get(`/api/auth/callback?code=${flow?.nonce}&state=${flow?.state}`).expect(302);
    expect(
      loadInstanceConfig((await getNewestConfigVersion(harness.tenantId))!.yaml).raw.admins,
    ).toBeUndefined();
  });

  it('refuses to start with no provider a login can be completed through', async () => {
    const agent = await claim();
    const refused = await agent.post('/-/setup/prove').send({}).expect(400);
    expect(refused.text).toContain('No identity provider is available');
    expect(await LoginFlow.count()).toBe(0);
  });

  it('sends no magic link without an address to send it to', async () => {
    const agent = await claim();
    await addMailTransport(agent);
    await addMagicLink(agent);

    const refused = await agent.post('/-/setup/prove').send({ provider: 'links' }).expect(400);
    expect(refused.text).toContain('Enter your full email address.');
    expect(sent).toEqual([]);
  });

  it('is not reachable by anybody who did not claim this instance', async () => {
    const page = await request(app.getHttpServer()).get('/-/setup');
    expect([page.status, page.headers.location]).toEqual([303, '/']);
    await request(app.getHttpServer()).post('/-/setup/prove').expect(404);
  });
});

function state() {
  return { source: config.configSource, hasAdministrator: config.hasAdministrator };
}

interface FakeIdp {
  issuer: string;
  stop(): Promise<void>;
}

async function startFakeIdp(): Promise<FakeIdp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  let base = '';

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', base);

      if (url.pathname === '/.well-known/openid-configuration') {
        return send(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          jwks_uri: `${base}/jwks`,
        });
      }
      if (url.pathname === '/jwks') {
        const jwk = await exportJWK(publicKey);
        return send(res, 200, { keys: [{ ...jwk, kid: 'k', alg: 'RS256', use: 'sig' }] });
      }
      if (url.pathname === '/token') {
        const body = new URLSearchParams(await readBody(req));
        const idToken = await new SignJWT({
          nonce: body.get('code') ?? '',
          email: 'someone@idp.test',
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'k' })
          .setIssuer(base)
          .setAudience(CLIENT_ID)
          .setSubject('subject-from-the-idp')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        return send(res, 200, { id_token: idToken });
      }

      // GitHub Enterprise Server shapes, for a github provider whose base_url is this server
      if (url.pathname === '/login/oauth/access_token') {
        return send(res, 200, { access_token: 'gh-token' });
      }
      if (url.pathname === '/api/v3/user') {
        return send(res, 200, { id: 4242, login: 'octo', name: 'Octo Cat' });
      }
      if (url.pathname === '/api/v3/user/emails') {
        return send(res, 200, [{ email: 'Octo@idp.test', primary: true, verified: true }]);
      }
      if (url.pathname === '/api/v3/user/teams') {
        return send(res, 200, []);
      }
      if (url.pathname === '/api/v3/user/installations') {
        return send(res, 200, { installations: [{ id: 99, account: { login: 'acme' } }] });
      }
      return send(res, 404, {});
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get issuer() {
      return base;
    },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function send(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
