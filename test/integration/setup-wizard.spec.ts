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
import { STEP_PROSE, SetupStepId } from '../../src/dashboard/setup/steps';
import { unclaimedInstanceConfig } from '../../src/dashboard/setup/unclaimed';
import { LoginFlow } from '../../src/db/models';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { formBody } from '../helpers/form';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp } from '../helpers/http';

let harness: Harness;
let app: INestApplication;
let idp: FakeIdp;
let config: ConfigService;

const CLIENT_ID = 'wizard-client';
const ORIGINAL_SOURCE = process.env[CONFIG_SOURCE_ENV];
const ORIGINAL_PATH = process.env[INSTANCE_CONFIG_PATH_ENV];
const ORIGINAL_INSECURE = process.env.SPEICHER_INSECURE_COOKIES;

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
  app = await bootTestApp(config);
});

afterEach(async () => {
  await app?.close();
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
  await db.query(`UPDATE tenants SET first_admin_login_at = NULL, setup_reopen_count = 0`, {
    type: QueryTypes.UPDATE,
  });
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

/*
  A step's card, found by the handle the page puts on it rather than by its copy:
  the wording is `STEP_PROSE`'s to change, and a spec that looked for a sentence
  reported a missing card the day one was reworded (five of these did).
*/
const card = (id: SetupStepId) => `data-spr-step="${id}"`;

/** Where each card is on the page, so the order can be asserted without prose */
const cardOrder = (html: string, ids: SetupStepId[]) => ids.map((id) => html.indexOf(card(id)));

describe('the first run', () => {
  it('goes from a claim to a proved administrator, typing no identity claim', async () => {
    const agent = await claim();

    const before = await agent.get('/-/setup').expect(200);
    /*
      The provider card and its heading. Not its `action` label: while the step is
      undone the card draws the kind tiles instead of the link, which is the whole
      point of the card -- so the heading is the part that is always there.
    */
    expect(before.text).toContain(card('provider'));
    expect(before.text).toContain(STEP_PROSE.provider.heading);
    expect(before.text).toContain('spr-setup-kinds');
    expect(await setup.showsClaimPage(harness.tenantId, state())).toBe(true);

    await addProvider(agent);
    const v1 = await getNewestConfigVersion(harness.tenantId);
    expect(v1?.version).toBe(1);
    expect(v1?.origin).toBe('setup');
    expect(v1?.applied_by).toBeNull();

    const middle = await agent.get('/-/setup').expect(200);
    expect(middle.text).toContain(card('administrator'));
    expect(middle.text).toContain(STEP_PROSE.administrator.heading);

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
        note: 'First administrator: someone@idp.test, named by their own first login',
      },
    ]);

    expect(await setup.claimWindowOpen(harness.tenantId)).toBe(false);
    expect(await setup.showsClaimPage(harness.tenantId, state())).toBe(false);

    await agent.get('/-/status').expect(200);
    const finished = await agent.get('/-/setup').expect(200);
    expect(finished.text).toContain('can no longer be claimed');
  });

  it('offers the kinds as cards, each landing on the form for that kind', async () => {
    const agent = await claim();

    const page = await agent.get('/-/setup').expect(200);
    expect(page.text).not.toContain('spr-account');
    expect(page.text).not.toContain('spr-search');
    expect(page.text).not.toContain('spr-signin');

    expect(page.text).toContain('Microsoft Entra ID');
    expect(page.text).toContain('href="/-/config/identity?kind=entra"');
    expect(page.text).toContain('Magic link (email)');

    const identity = await agent.get('/-/config/identity?kind=github').expect(303);
    expect(identity.headers.location).toBe('/-/config/identity/github?kind=github');

    const nonsense = await agent.get('/-/config/identity?kind=ldap').expect(200);
    expect(nonsense.text).not.toMatch(/<details class="spr-modal" open>/);
  });

  it('moves the cards to the next step once the provider is there', async () => {
    const agent = await claim();
    await addProvider(agent);
    const page = await agent.get('/-/setup').expect(200);

    expect(page.text).not.toContain('href="/-/config/identity?kind=entra"');
    // Done, so the card offers the review label rather than the add one.
    expect(page.text).toContain(STEP_PROSE.provider.reviewAction);
    expect(page.text).not.toContain(STEP_PROSE.provider.action);

    expect(page.text).toContain('href="/-/config/sources?kind=git"');
    expect(page.text).toContain('Plain git remote');
  });

  it('lands a source kind on its form too, which is a table and not tiles', async () => {
    const agent = await claim();
    const sources = await agent.get('/-/config/sources?kind=git').expect(303);
    expect(sources.headers.location).toBe('/-/config/sources/git?kind=git');
  });

  it('puts the login last, because completing it ends the flow', async () => {
    const agent = await claim();
    const page = await agent.get('/-/setup').expect(200);
    const order = cardOrder(page.text, ['provider', 'content', 'administrator']);
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    await agent.get('/-/config/identity').expect(200);
    await agent.get('/-/config/sources').expect(200);
  });

  it('sends the magic-link card to the relay first, as a step ahead of the provider', async () => {
    const agent = await claim();

    const fresh = await agent.get('/-/setup').expect(200);
    expect(fresh.text).not.toContain(card('mail'));
    expect(fresh.text).toContain('href="/-/config/mail"');
    expect(fresh.text).not.toContain('href="/-/config/identity?kind=magic-link"');
    expect(fresh.text).toContain('href="/-/config/identity?kind=entra"');

    const relay = await agent.get('/-/config/mail').expect(200);
    expect(relay.text).toMatch(/aria-current="step"[\s\S]*?Mail transport/);
    expect(relay.text).toMatch(/href="\/-\/config\/mail" aria-current="page"/);
    expect(relay.text.indexOf('/-/config/mail')).toBeLessThan(
      relay.text.indexOf('/-/config/identity'),
    );

    const stored = await addMailTransport(agent);
    expect(stored.headers.location).toBe('/-/config/identity?kind=magic-link');

    const settled = await agent.get('/-/setup').expect(200);
    expect(settled.text).toContain(card('mail'));
    expect(settled.text).toContain(STEP_PROSE.mail.reviewAction);
    expect(settled.text).toContain('href="/-/config/identity?kind=magic-link"');
    const order = cardOrder(settled.text, ['mail', 'provider', 'content', 'administrator']);
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    await addMagicLink(agent);
    const after = await agent.get('/-/config').expect(200);
    expect(after.text).toMatch(
      /spr-progress-step spr-progress-done[\s\S]*?Mail transport[\s\S]*?>done</,
    );
    expect(after.text).toMatch(/aria-current="step"[\s\S]*?Content source/);
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

  it('hands a finished step over to the next, so nobody has to go looking for it', async () => {
    const agent = await claim();

    await agent.get('/-/config/identity?add=wizard&kind=oidc').expect(303);
    const draft = await agent.get('/-/config/identity/wizard?kind=oidc').expect(200);
    const first = await agent
      .post('/-/config/identity/wizard?kind=oidc')
      .send({
        ...formBody(draft.text),
        'auth.providers.wizard.issuer': idp.issuer,
        'auth.providers.wizard.client_id': CLIENT_ID,
        intent: 'apply',
      })
      .expect(303);
    expect(first.headers.location).toBe('/-/config/sources');

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
    expect(source.headers.location).toBe('/-/setup/administrator');
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

  it('offers every unfinished step its choices, not only the first', async () => {
    const agent = await claim();
    const page = await agent.get('/-/setup').expect(200);
    expect(page.text).toContain('/-/config/identity?kind=entra');
    expect(page.text).toContain('/-/config/sources?kind=git');
  });

  it('gives the login a page of its own, which the overview links to', async () => {
    const agent = await claim();
    await addProvider(agent);

    const overview = await agent.get('/-/setup').expect(200);
    expect(overview.text).toContain('href="/-/setup/administrator"');
    expect(overview.text).not.toContain('action="/-/setup/prove"');

    const page = await agent.get('/-/setup/administrator').expect(200);
    expect(page.text).toContain('action="/-/setup/prove"');
    expect(page.text).toContain('spr-progress');
    expect(page.text).toMatch(/aria-current="step"[\s\S]*?Administrator/);
  });

  it('sends a claim session back to the wizard from anywhere else', async () => {
    const agent = await claim();

    for (const path of ['/', '/-/status', '/-/graph', '/-/logs', '/handbook/anything']) {
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
    expect(config.text).toMatch(/aria-current="step"[\s\S]*?Administrator/);
    expect(config.text).toContain('href="/-/config/identity"');
    expect(config.text).toContain('href="/-/config/sources"');

    expect((await agent.get('/-/setup').expect(200)).text).not.toContain('spr-progress');

    expect(config.text).not.toContain('/-/graph');

    const identity = await agent.get('/-/config/identity').expect(200);
    expect(identity.text).not.toContain('spr-crumbs');

    expect(identity.text).toMatch(
      /spr-progress-step spr-progress-done spr-progress-current[\s\S]*?Identity provider/,
    );
    expect(identity.text.match(/aria-current="step"/g)).toHaveLength(1);
    expect(identity.text).toMatch(/href="\/-\/config\/identity" aria-current="page"/);
  });

  it('drops the bar once the flow is over', async () => {
    const agent = await claim();
    await addProvider(agent);
    await prove(agent);

    const config = await agent.get('/-/config').expect(200);
    expect(config.text).not.toContain('spr-progress');
    expect(config.text).not.toContain('/-/setup"');
    expect((await agent.get('/-/config/identity').expect(200)).text).toContain('spr-crumbs');
  });

  it('resumes after the tab is closed, through a fresh claim', async () => {
    const first = await claim();
    await addProvider(first);

    const second = await claim();
    const page = await second.get('/-/setup').expect(200);

    // The provider card is done and the administrator card is still to do.
    expect(page.text).toContain(STEP_PROSE.provider.reviewAction);
    expect(page.text).toContain(card('administrator'));
    expect(page.text).toContain(STEP_PROSE.administrator.heading);

    await prove(second);
    expect(await setup.claimWindowOpen(harness.tenantId)).toBe(false);
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
    expect(refused.text).toContain('OpenID Connect');
    expect(await LoginFlow.count()).toBe(0);
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
