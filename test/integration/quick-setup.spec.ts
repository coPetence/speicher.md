import { generateKeyPairSync } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import request from 'supertest';
import { parse } from 'yaml';

import { ConfigService } from '../../src/config/config.service';
import {
  CONFIG_SOURCE_ENV,
  getNewestConfigVersion,
  loadActiveInstanceConfig,
  saveInstanceConfig,
} from '../../src/config/loader';
import {
  GITHUB_APP_FORM_COOKIE,
  GITHUB_APP_HANDOFF_COOKIE,
  GithubAppManifestService,
} from '../../src/dashboard/configurator/config-page/github-app-manifest';
import { SIGN_IN_AUDIENCES } from '../../src/dashboard/configurator/github-sign-in-audience';
import { githubProviderStarter } from '../../src/dashboard/configurator/quick-setup/github-app';
import { quickSetupPath } from '../../src/dashboard/configurator/quick-setup/model';
import { GITHUB_INSTALL_COOKIE } from '../../src/auth/github.service';
import { SESSION_COOKIE } from '../../src/auth/session.service';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { GITHUB_APP_LOOKUP_FETCH } from '../../src/github/app-links';
import type { AppManifest } from '../../src/github/app-manifest';
import { Harness, PRINCIPALS, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs1',
  format: 'pem',
}) as string;

const CONVERTED = {
  id: 4242,
  slug: 'speicher-md',
  owner: { login: 'acme', type: 'Organization' },
  html_url: 'https://github.com/apps/speicher-md',
  pem: PEM,
  webhook_secret: 'from-github',
  client_id: 'Iv1.abc',
  client_secret: 'secret',
};
const INSTALL_URL = 'https://github.com/apps/speicher-md/installations/new';

let harness: Harness;
let config: ConfigService;
let app: INestApplication;
let ops: string;
const ORIGINAL_SOURCE = process.env[CONFIG_SOURCE_ENV];
// GitHub as the manifest flow reaches it, and as a source's ready page looks its App up
const github = jest.fn<Promise<Response>, Parameters<typeof fetch>>();
const lookup = jest.fn<Promise<Response>, Parameters<typeof fetch>>();

beforeAll(async () => {
  harness = await createHarness();
  process.env[CONFIG_SOURCE_ENV] = 'database';
  await resetVersions();
  config = new ConfigService(await loadActiveInstanceConfig());
  app = await bootTestApp(
    config,
    [],
    [
      {
        token: GithubAppManifestService,
        value: new GithubAppManifestService(github as typeof fetch),
      },
      { token: GITHUB_APP_LOOKUP_FETCH, value: lookup },
    ],
  );
});

beforeEach(async () => {
  await resetVersions();
  ops = await sessionCookieFor(harness.tenantId, 'ops');
  github.mockReset();
  github.mockImplementation(async () => new Response(JSON.stringify(CONVERTED), { status: 201 }));
  lookup.mockReset();
  installations = [];
  repositories = 0;
  repos = {};
  lookup.mockImplementation(async (input) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    if (path.endsWith('/access_tokens')) {
      return json({ token: 't', expires_at: '2099-01-01T00:00:00Z' }, 201);
    }
    if (path === '/app/installations') return json(installations);
    if (path === '/installation/repositories') {
      const names = Object.keys(repos);
      return json({
        total_count: names.length || repositories,
        repositories: names.map((name) => ({ full_name: `acme/${name}`, default_branch: 'main' })),
      });
    }
    const tree = /^\/repos\/acme\/([^/]+)\/git\/trees\/main$/.exec(path);
    if (tree) {
      const files = repos[tree[1]];
      if (files === 'empty') return new Response('', { status: 409 });
      return json({ tree: Object.keys(files ?? {}).map((each) => ({ path: each, type: 'blob' })) });
    }
    const content = /^\/repos\/acme\/([^/]+)\/contents\/(.+)$/.exec(path);
    if (content) {
      const files = repos[content[1]];
      return new Response(files === 'empty' ? '' : (files?.[content[2]] ?? ''), { status: 200 });
    }
    return json({ slug: 'speicher-md', owner: CONVERTED.owner });
  });
});

// The repositories the installation on acme reads, by name: their files, or `empty` for one without a commit
let repos: Record<string, Record<string, string> | 'empty'> = {};

// The installations of the source's App, and how many repositories the one on acme reads
let installations: { id: number; account: { login: string }; repository_selection: string }[] = [];
let repositories = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterAll(async () => {
  await app?.close();
  if (ORIGINAL_SOURCE === undefined) delete process.env[CONFIG_SOURCE_ENV];
  else process.env[CONFIG_SOURCE_ENV] = ORIGINAL_SOURCE;
  await harness?.close();
  await closeSequelize();
});

async function resetVersions(): Promise<void> {
  await getSequelize().query(`DELETE FROM instance_configs`, { type: QueryTypes.DELETE });
  const seeded = await loadActiveInstanceConfig();
  if (config) config.adopt(seeded);
}

async function stored(): Promise<Record<string, any>> {
  const row = await getNewestConfigVersion(harness.tenantId);
  return parse(row!.yaml) as Record<string, any>;
}

/** Stores a version with a mail transport, which a magic link provider needs */
async function storeMailTransport(): Promise<void> {
  const row = await getNewestConfigVersion(harness.tenantId);
  await saveInstanceConfig(
    harness.tenantId,
    `${row!.yaml}\nmail:\n  host: 127.0.0.1\n  port: 2525\n  from: Docs <docs@example.test>\n`,
    { origin: 'admin', appliedBy: null },
  );
  config.adopt(await loadActiveInstanceConfig());
}

/** Presses the add modal's main button, as the modal posts its form */
function create(section: string, fields: Record<string, string>, cookie = ops) {
  return request(app.getHttpServer())
    .post(quickSetupPath(section))
    .set('cookie', cookie)
    .type('form')
    .send(fields);
}

/**
 * Follows the redirect a quick setup answers with to the page that posts the manifest to GitHub, as the browser does,
 * and answers with that page and the cookies the setup set
 */
async function handedOff(posted: request.Test): Promise<request.Response> {
  const started = await posted.expect(303);
  expect(started.headers.location).toMatch(/\/manifest\/handoff\?from=modal$/);
  const handoff = cookieNamed(started, GITHUB_APP_HANDOFF_COOKIE);
  const page = await request(app.getHttpServer())
    .get(started.headers.location)
    .set('cookie', `${ops}; ${handoff}`)
    .expect(200);
  page.headers['set-cookie'] = started.headers['set-cookie'];
  return page;
}

function cookieNamed(response: request.Response, name: string): string {
  const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
  const cookie = cookies.find((each) => each.startsWith(`${name}=`));
  if (!cookie) throw new Error(`no ${name} cookie was set`);
  return cookie.split(';')[0];
}

function manifestPostUrl(html: string): URL {
  const action = /<form method="post" action="([^"]+)"/.exec(html)?.[1];
  if (!action) throw new Error('the page has no form that posts the manifest');
  return new URL(action.replace(/&amp;/g, '&'));
}

function manifestOf(html: string): AppManifest {
  const value = /name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? '';
  return JSON.parse(value.replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as AppManifest;
}

function formCookie(response: request.Response): string {
  return cookieNamed(response, GITHUB_APP_FORM_COOKIE);
}

// What the modal asks a GitHub provider and a GitHub source, for an App on the organization acme
const ON_ACME: Record<string, Record<string, string>> = {
  identity: { 'quick:github:audience': 'org', 'quick:github:org': 'acme' },
  sources: { 'quick:github:account': 'org', 'quick:github:org': 'acme' },
};

/** Sets a member up from the modal and comes back from GitHub, as the browser does */
async function createOnGithub(
  section: string,
  id: string,
  fields: Record<string, string> = ON_ACME[section],
): Promise<request.Response> {
  const started = await handedOff(create(section, { kind: 'github', add: id, ...fields }));
  const state = manifestPostUrl(started.text).searchParams.get('state')!;
  return request(app.getHttpServer())
    .get(`/-/config/${section}/${id}/github-app/manifest/callback?code=c&state=${state}`)
    .set('cookie', `${ops}; ${formCookie(started)}`)
    .expect(303);
}

function ready(path: string) {
  return request(app.getHttpServer()).get(path).set('cookie', ops);
}

/** The states of a ready page's steps, in order */
function stepStates(html: string): string[] {
  return [...html.matchAll(/data-spr-step-state="([a-z]+)"/g)].map((match) => match[1]);
}

describe('the add modal of the identity providers', () => {
  it('asks who should be able to sign in, and posts to the quick setup', async () => {
    const page = await request(app.getHttpServer())
      .get('/-/config/identity')
      .set('cookie', ops)
      .expect(200);
    expect(page.text).toContain('data-spr-reveal-root');
    // A dropdown, one option per answer
    const select = /<select[^>]*name="quick:github:audience"[\s\S]*?<\/select>/.exec(
      page.text,
    )?.[0];
    for (const audience of SIGN_IN_AUDIENCES) {
      expect(select).toContain(`value="${audience.value}"`);
    }
    // The organization is asked for both answers that name one
    expect(page.text).toContain('data-spr-shown-when="org org-and-others"');
    expect(page.text).toContain('name="quick:github:org"');
    expect(page.text).toContain(`formaction="${quickSetupPath('identity')}"`);
    expect(page.text).toContain(githubProviderStarter.setup.submitLabel);
    // Beside the main button, for every kind set up in one go
    expect(page.text).toMatch(
      /class="spr-quick-manual"\s+data-spr-shown-with="kind"\s+data-spr-shown-when="github magic-link"/,
    );
  });

  it('opens on a kind set up in one go, and sends any other kind to its page', async () => {
    const github = await request(app.getHttpServer())
      .get('/-/config/identity?kind=github')
      .set('cookie', ops)
      .expect(200);
    expect(github.text).toMatch(/<details class="spr-modal[^"]*" open>/);

    await request(app.getHttpServer())
      .get('/-/config/identity?kind=oidc')
      .set('cookie', ops)
      .expect(303)
      .expect('location', /\/-\/config\/identity\/oidc\?kind=oidc$/);
  });
});

describe('setting up a GitHub identity provider from the add modal', () => {
  it('hands a private App of the organization over to GitHub for its members, and stores nothing yet', async () => {
    const before = await stored();
    const response = await handedOff(
      create('identity', {
        kind: 'github',
        add: 'octo',
        'quick:github:audience': 'org',
        'quick:github:org': 'acme',
      }),
    );

    const target = manifestPostUrl(response.text);
    expect(`${target.origin}${target.pathname}`).toBe(
      'https://github.com/organizations/acme/settings/apps/new',
    );
    expect(manifestOf(response.text).public).toBe(false);
    expect(manifestOf(response.text).setup_url).toMatch(/\/-\/config\/identity\/octo\/ready$/);
    expect(formCookie(response)).toBeTruthy();
    expect(await stored()).toEqual(before);
  });

  it('leads Back from GitHub to the add modal, never to GitHub again', async () => {
    const started = await create('identity', {
      kind: 'github',
      add: 'octo',
      'quick:github:audience': 'org',
      'quick:github:org': 'acme',
    }).expect(303);
    const handoff = cookieNamed(started, GITHUB_APP_HANDOFF_COOKIE);
    await request(app.getHttpServer())
      .get(started.headers.location)
      .set('cookie', `${ops}; ${handoff}`)
      .expect(200);

    // The visit took the cookie; Back from GitHub asks for the page again without it
    await request(app.getHttpServer())
      .get(started.headers.location)
      .set('cookie', ops)
      .expect(303)
      .expect('location', '/-/config/identity?kind=github');
  });

  it.each([
    ['org-and-others', '/organizations/acme/settings/apps/new', true],
    ['anyone', '/settings/apps/new', true],
    ['me', '/settings/apps/new', false],
  ])(
    'creates the App for %s where GitHub takes the right people, ignoring an organization typed before',
    async (audience, path, isPublic) => {
      const response = await handedOff(
        create('identity', {
          kind: 'github',
          add: 'octo',
          'quick:github:audience': audience,
          'quick:github:org': 'acme',
        }),
      );
      expect(manifestPostUrl(response.text).pathname).toBe(path);
      expect(manifestOf(response.text).public).toBe(isPublic);
    },
  );

  it('saves the provider when GitHub comes back, installs its App, and lists both on its ready page', async () => {
    const back = await createOnGithub('identity', 'octo');
    // An organization's App goes on to be installed, which returns to the ready modal
    expect(back.headers.location).toBe('/-/config/identity/octo/install');
    // Nothing but the App: the modal carries no page whose fields would be decoded
    expect((await stored()).auth.providers.octo).toEqual({
      type: 'github',
      client_id: 'Iv1.abc',
      client_secret: 'secret',
      app: {
        client_id: 'Iv1.abc',
        slug: 'speicher-md',
        owner_account: 'acme',
        owner_is_organization: true,
        public: false,
      },
    });

    const page = await ready('/-/config/identity/octo/ready').expect(200);
    expect(stepStates(page.text)).toEqual(['done', 'done', 'next']);
    expect(page.text).toContain('Only members of <strong>acme</strong> can sign in</li>');
    // The App's own page on GitHub, beside the point that it was created
    expect(page.text).toContain(
      'class="spr-ready-link" href="https://github.com/organizations/acme/settings/apps/speicher-md"',
    );
    // A modal over the list the provider joined, which Done leaves for the list alone
    expect(page.text).toContain('<details class="spr-modal spr-ready-modal" open>');
    expect(page.text).toContain('href="/-/config/identity/octo"');
    // Outside the first setup the main button is Done, which closes onto the list
    expect(page.text).toMatch(/href="\/-\/config\/identity" data-spr-ready-primary>Done</);
    expect(page.text).not.toContain('/api/auth/login');
    expect(page.text).toContain('<strong>speicher-md</strong>');
    expect(page.text).toContain('href="/-/config/identity/octo/install"');
  });

  it('shows the App as installed when GitHub sends the browser back after installing it', async () => {
    await createOnGithub('identity', 'octo');
    const page = await ready(
      '/-/config/identity/octo/ready?installation_id=1&setup_action=install',
    ).expect(200);
    expect(stepStates(page.text)).toEqual(['done', 'done', 'done']);
    expect(page.text).not.toContain('/-/config/identity/octo/install');
    expect(page.text).toContain(
      'href="https://github.com/organizations/acme/settings/installations/1"',
    );
  });

  it('says on the provider page who can sign in', async () => {
    await createOnGithub('identity', 'octo', {
      'quick:github:audience': 'org-and-others',
      'quick:github:org': 'acme',
    });
    expect((await stored()).auth.providers.octo.app.public).toBe(true);
    const page = await ready('/-/config/identity/octo').expect(200);
    expect(page.text).toContain(
      'Members of acme and anyone else with a GitHub account can sign in.',
    );
  });

  it('lets anyone sign in with a public App on a personal account, which has no teams to install for', async () => {
    github.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ...CONVERTED, owner: { login: 'ferdi', type: 'User' } }), {
          status: 201,
        }),
    );
    // Nothing to install, so GitHub's return lands on the ready modal
    const back = await createOnGithub('identity', 'octo', { 'quick:github:audience': 'anyone' });
    expect(back.headers.location).toBe('/-/config/identity/octo/ready');
    const page = await ready('/-/config/identity/octo/ready').expect(200);
    expect(page.text).toContain('Anyone with a GitHub account can sign in</li>');
    // A personal account has no teams, so nothing to install
    expect(stepStates(page.text)).toEqual(['done', 'done']);
    expect(page.text).not.toContain('/-/config/identity/octo/install');
  });

  it('lets only its owner sign in with a private App on a personal account', async () => {
    github.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ...CONVERTED, owner: { login: 'ferdi', type: 'User' } }), {
          status: 201,
        }),
    );
    await createOnGithub('identity', 'octo', { 'quick:github:audience': 'me' });
    const page = await ready('/-/config/identity/octo/ready').expect(200);
    expect(page.text).toContain('Only <strong>ferdi</strong> can sign in</li>');
    expect(stepStates(page.text)).toEqual(['done', 'done']);
  });

  it('keeps the modal open with the reason when no organization is named', async () => {
    const response = await create('identity', {
      kind: 'github',
      add: 'octo',
      'quick:github:audience': 'org',
      'quick:github:org': '  ',
    }).expect(400);
    expect(response.text).toContain('Name the organization the App is created on.');
    expect(response.text).toMatch(/<details class="spr-modal[^"]*" open>/);
    expect(response.text).toContain('value="octo"');
    expect(github).not.toHaveBeenCalled();
  });

  it('refuses an organization name GitHub would not take', async () => {
    const response = await create('identity', {
      kind: 'github',
      add: 'octo',
      'quick:github:audience': 'org-and-others',
      'quick:github:org': 'ac me',
    }).expect(400);
    expect(response.text).toContain('is not a GitHub organization name');
    expect(response.text).toContain('value="ac me"');
  });

  it('refuses a short id that is taken before the browser goes to GitHub', async () => {
    const response = await create('identity', {
      kind: 'github',
      add: 'entra',
      'quick:github:audience': 'me',
    }).expect(400);
    expect(response.text).toContain('The provider &quot;entra&quot; already exists');
    expect(response.headers['set-cookie'] ?? []).not.toContainEqual(
      expect.stringContaining(GITHUB_APP_FORM_COOKIE),
    );
  });

  it('refuses a short id that is not one', async () => {
    await create('identity', { kind: 'github', add: '-octo', 'quick:github:audience': 'me' })
      .expect(400)
      .expect(/is not a short id/);
  });
});

describe("installing a provider's App from the modal it ends on", () => {
  it('asks GitHub to sign the person in as they install an App of an organization', async () => {
    const org = await handedOff(
      create('identity', {
        kind: 'github',
        add: 'octo',
        'quick:github:audience': 'org',
        'quick:github:org': 'acme',
      }),
    );
    expect(manifestOf(org.text).request_oauth_on_install).toBe(true);

    // Nothing is installed on a personal account, so nothing is asked there
    const mine = await handedOff(
      create('identity', { kind: 'github', add: 'mine', 'quick:github:audience': 'me' }),
    );
    expect(manifestOf(mine.text).request_oauth_on_install).toBeUndefined();
  });

  it('starts the installation here, so its return finds this browser', async () => {
    await createOnGithub('identity', 'octo');
    const started = await ready('/-/config/identity/octo/install')
      .expect(303)
      .expect('location', INSTALL_URL);
    expect(cookieNamed(started, GITHUB_INSTALL_COOKIE)).toBeTruthy();
    expect(([] as string[]).concat(started.headers['set-cookie'] ?? []).join()).toContain(
      'Path=/api/auth/github/callback',
    );
  });

  it('leads the return back to the ready modal, and signs nobody in outside the first setup', async () => {
    await createOnGithub('identity', 'octo');
    const started = await ready('/-/config/identity/octo/install').expect(303);
    const back = await request(app.getHttpServer())
      .get('/api/auth/github/callback?code=from-github&installation_id=7&setup_action=install')
      .set('cookie', `${ops}; ${cookieNamed(started, GITHUB_INSTALL_COOKIE)}`)
      .expect(302);
    expect(back.headers.location).toBe(
      '/-/config/identity/octo/ready?setup_action=install&installation_id=7',
    );
    // The code was not used, so no session was made from it
    expect(back.headers['set-cookie'] ?? []).not.toContainEqual(
      expect.stringContaining(`${SESSION_COOKIE}=`),
    );
  });

  it('sends a return no installation of this browser started to the identity providers', async () => {
    await request(app.getHttpServer())
      .get('/api/auth/github/callback?code=from-elsewhere&installation_id=7&setup_action=install')
      .set('cookie', ops)
      .expect(302)
      .expect('location', '/-/config/identity');
  });

  it('answers 404 for a provider whose App this instance did not create', async () => {
    await ready('/-/config/identity/entra/install').expect(404);
  });
});

describe('a kind the add modal does not set up in one go', () => {
  it('goes to the new member page, as the manual button does', async () => {
    await create('identity', { kind: 'oidc', add: 'okta' })
      .expect(303)
      .expect('location', '/-/config/identity/okta?kind=oidc');
  });

  it('answers 404 for a kind the section does not offer', async () => {
    await create('identity', { kind: 'gitlab', add: 'lab' }).expect(404);
  });

  it('answers 404 to somebody who is not an administrator', async () => {
    const alice = await sessionCookieFor(harness.tenantId, 'alice');
    await create('identity', { kind: 'github', add: 'octo' }, alice).expect(404);
  });
});

describe('setting up a magic link provider from the add modal', () => {
  it('refuses while no mail transport is configured', async () => {
    const response = await create('identity', { kind: 'magic-link', add: 'mail' }).expect(400);
    expect(response.text).toContain('no mail transport');
    expect((await stored()).auth.providers.mail).toBeUndefined();
  });

  it('saves the provider straight away, and lands on its ready page', async () => {
    await storeMailTransport();
    await create('identity', { kind: 'magic-link', add: 'mail' })
      .expect(303)
      .expect('location', '/-/config/identity/mail/ready');
    // Saved as seeded: a body without the page's checkboxes would have switched `same_browser` off
    expect((await stored()).auth.providers.mail).toEqual({ type: 'magic-link' });

    const page = await ready('/-/config/identity/mail/ready').expect(200);
    expect(stepStates(page.text)).toEqual(['done']);
  });
});

describe('setting up a GitHub content source from the add modal', () => {
  it('saves the source when GitHub comes back, installs its App, and names it on the ready page', async () => {
    const back = await createOnGithub('sources', 'team');
    expect(back.headers.location).toBe(INSTALL_URL);
    expect((await stored()).forges.team).toMatchObject({
      type: 'github',
      app_id: '4242',
      // The account the App was created on, which every repository it reads belongs to
      default_repository_owner: 'acme',
    });

    // Not installed yet, as GitHub tells it
    const page = await ready('/-/config/sources/team/ready').expect(200);
    expect(stepStates(page.text)).toEqual(['done', 'next']);
    expect(page.text).toContain('<strong>speicher-md</strong> created on <strong>acme</strong>');
    expect(page.text).toContain(`href="${INSTALL_URL}"`);
    expect(lookup).toHaveBeenCalledWith('https://api.github.com/app', expect.anything());
  });

  it('asks which repositories to sync, from an organization or the personal account', async () => {
    const page = await request(app.getHttpServer())
      .get('/-/config/sources?kind=github')
      .set('cookie', ops)
      .expect(200);
    expect(page.text).toContain('Which repositories do you want to sync');
    expect(page.text).toContain('From an organization');
    expect(page.text).toContain('From my personal account');
  });

  it('counts the repositories the installation reads, linking to where to change which', async () => {
    await createOnGithub('sources', 'team');
    installations = [{ id: 5, account: { login: 'acme' }, repository_selection: 'selected' }];
    repositories = 3;
    const page = await ready(
      '/-/config/sources/team/ready?installation_id=5&setup_action=install',
    ).expect(200);

    expect(stepStates(page.text)).toEqual(['done', 'done']);
    // The installation's page on GitHub, in a new tab, marked as leaving this site
    expect(page.text).toMatch(
      /App installed on <strong>acme<\/strong>, with access to <a class="spr-ready-link spr-ready-inline" href="https:\/\/github.com\/organizations\/acme\/settings\/installations\/5" target="_blank" rel="noopener">3 selected repositories<svg/,
    );
    expect(page.text).not.toContain(`href="${INSTALL_URL}"`);
  });

  it('says so when the installation reads every repository', async () => {
    await createOnGithub('sources', 'team');
    installations = [{ id: 5, account: { login: 'acme' }, repository_selection: 'all' }];
    repositories = 12;
    const page = await ready('/-/config/sources/team/ready').expect(200);
    expect(page.text).toContain('>all 12 repositories<svg');
  });

  it('still lists the steps when GitHub cannot be asked for the App', async () => {
    await createOnGithub('sources', 'team');
    lookup.mockImplementation(async () => new Response('', { status: 502 }));
    const page = await ready('/-/config/sources/team/ready').expect(200);
    expect(stepStates(page.text)).toEqual(['done']);
  });
});

describe('checking the repositories a source reads', () => {
  const INSTALLED = [{ id: 5, account: { login: 'acme' }, repository_selection: 'all' }];

  it('leads on from the ready modal of an installed source', async () => {
    await createOnGithub('sources', 'team');
    installations = INSTALLED;
    repositories = 2;
    const page = await ready('/-/config/sources/team/ready').expect(200);
    expect(page.text).toMatch(
      /href="\/-\/config\/sources\/team\/check" data-spr-ready-primary>Check repositories/,
    );
  });

  it('says for each repository whether it is ready, and offers to create a .speicher.yaml', async () => {
    await createOnGithub('sources', 'team');
    installations = INSTALLED;
    repos = {
      handbook: { '.speicher.yaml': 'version: 1\naccess:\n  groups: [engineering]\n', 'a.md': '' },
      wiki: { 'README.md': '' },
      notes: { '.speicher.yaml': 'version: 1\naccess:\n  groups: [enginering, contractors]\n' },
      broken: { '.speicher.yaml': 'version: 1\n' },
      fresh: 'empty',
    };
    const page = await ready('/-/config/sources/team/check?run=1').expect(200);

    expect(page.text).toContain('<details class="spr-modal spr-check-modal" open>');
    const states = [...page.text.matchAll(/data-spr-repo-state="([a-z-]+)"/g)].map((m) => m[1]);
    expect(states).toEqual(['ready', 'unpublished', 'unknown-groups', 'invalid', 'unpublished']);
    expect(page.text).toContain('1 of 5 repositories are ready');
    // The group links to its page
    expect(page.text).toContain(
      'Readable by <a href="/-/config/groups/engineering">engineering</a>',
    );
    expect(page.text).toContain(
      '<code>enginering</code> (did you mean <code>engineering</code>?), <code>contractors</code>',
    );
    expect(page.text).toContain('It has no <code>access</code> block');

    // The modal that picks who may read it, before GitHub's new-file page opens
    expect(page.text).toContain(
      'href="/-/config/sources/team/config-file?repository=acme%2Fwiki&amp;branch=main"',
    );
  });

  describe('creating a .speicher.yaml from the check', () => {
    const MODAL = '/-/config/sources/team/config-file?repository=acme%2Fwiki&branch=main';

    function pick(fields: Record<string, string | string[]>, path = MODAL) {
      return request(app.getHttpServer()).post(path).set('cookie', ops).type('form').send(fields);
    }

    it('offers every group of the instance, none of them ticked, and lets the post go on to GitHub', async () => {
      await createOnGithub('sources', 'team');
      const page = await ready(MODAL).expect(200);

      expect(page.text).toContain(
        'Who may read <span data-spr-config-file-repository>acme/wiki</span>?',
      );
      const offered = [...page.text.matchAll(/data-spr-grant-group="([^"]+)"/g)].map((m) => m[1]);
      expect(offered).toEqual(['engineering', 'commercial', 'client-northwind', 'platform-ops']);
      expect(page.text).not.toMatch(/name="grant" value="[^"]+" checked/);
      expect(page.text).toContain('target="_blank"');
      expect(String(page.headers['content-security-policy'])).toMatch(
        /form-action 'self' https:\/\/github\.com/,
      );
    });

    it('opens GitHub’s new-file page with a file that grants the picked groups only', async () => {
      await createOnGithub('sources', 'team');
      const sent = await pick({ grant: ['engineering', 'platform-ops', 'no-such-group'] }).expect(
        303,
      );

      const url = new URL(sent.headers.location);
      expect(`${url.origin}${url.pathname}`).toBe('https://github.com/acme/wiki/new/main');
      expect(url.searchParams.get('filename')).toBe('.speicher.yaml');
      expect(url.searchParams.get('value')).toContain('groups: [engineering, platform-ops]');
    });

    it('asks again when no group is picked', async () => {
      await createOnGithub('sources', 'team');
      const refused = await pick({}).expect(400);
      expect(refused.text).toContain('Pick at least one group.');
    });

    it('refuses a repository that is not an owner and a name', async () => {
      await createOnGithub('sources', 'team');
      await ready(
        '/-/config/sources/team/config-file?repository=..%2F..%2Fevil&branch=main',
      ).expect(404);
      await pick(
        { grant: 'engineering' },
        '/-/config/sources/team/config-file?repository=acme%2Fwiki',
      ).expect(404);
    });

    it('waits closed on the repositories page, for the Create links to open in place', async () => {
      await createOnGithub('sources', 'team');
      const page = await ready('/-/repositories').expect(200);
      expect(page.text).toMatch(
        /<details class="spr-modal spr-groups-modal" data-spr-config-file-picker>/,
      );
      expect(page.text).toContain('data-spr-config-file-none hidden');
      expect(String(page.headers['content-security-policy'])).toMatch(
        /form-action 'self' https:\/\/github\.com/,
      );
    });

    it('opens over the repositories page when it was asked for there, and leads back to it', async () => {
      await createOnGithub('sources', 'team');
      const page = await ready(
        '/-/repositories?config_file=team&repository=acme%2Fwiki&branch=main',
      ).expect(200);
      expect(page.text).toContain(
        'Who may read <span data-spr-config-file-repository>acme/wiki</span>?',
      );
      expect(page.text).toContain('href="/-/repositories" data-spr-config-file-back>Back</a>');
      expect(page.text).toContain(
        'action="/-/config/sources/team/config-file?repository=acme%2Fwiki&amp;branch=main&amp;back=setup"',
      );
      expect(String(page.headers['content-security-policy'])).toMatch(
        /form-action 'self' https:\/\/github\.com/,
      );

      // Nothing picked: asked again over the repositories page
      const again = await pick(
        {},
        '/-/config/sources/team/config-file?repository=acme%2Fwiki&branch=main&back=setup',
      ).expect(303);
      expect(again.headers.location).toBe(
        '/-/repositories?config_file=team&repository=acme%2Fwiki&branch=main&picked=none',
      );
      const asked = await ready(again.headers.location).expect(200);
      // Under the list, which is marked, as a field with a problem is
      expect(asked.text).toContain(
        '<p class="spr-field-problem" role="alert">Pick at least one group.</p>',
      );
      expect(asked.text).toContain('<ul class="spr-groups-list" data-spr-invalid>');

      // Picked: on to GitHub as from the sources
      const sent = await pick(
        { grant: 'engineering' },
        '/-/config/sources/team/config-file?repository=acme%2Fwiki&branch=main&back=setup',
      ).expect(303);
      expect(sent.headers.location).toMatch(/^https:\/\/github\.com\/acme\/wiki\/new\/main\?/);
    });
  });

  it('says so when the App is not installed yet, with the way to install it', async () => {
    await createOnGithub('sources', 'team');
    const page = await ready('/-/config/sources/team/check?run=1').expect(200);
    expect(page.text).toContain('is not installed on <strong>acme</strong> yet');
    expect(page.text).toContain(`href="${INSTALL_URL}"`);
  });

  it('answers 404 for a source that is no GitHub App', async () => {
    await ready('/-/config/sources/nowhere/check').expect(404);
  });
});

describe('a check that asks GitHub', () => {
  it('answers at once with a pending modal, and asks GitHub only at the address it runs at', async () => {
    await createOnGithub('sources', 'team');
    installations = [{ id: 5, account: { login: 'acme' }, repository_selection: 'all' }];
    repos = { wiki: { 'README.md': '' } };
    lookup.mockClear();

    for (const path of ['check', 'groups']) {
      const page = await ready(`/-/config/sources/team/${path}`).expect(200);
      const key = path === 'check' ? 'check:team' : 'groups:team';
      expect(page.text).toContain(
        `data-spr-defer-key="${key}" data-spr-defer="/-/config/sources/team/${path}?run=1" aria-busy="true"`,
      );
      // Where nothing runs, the link runs the check by loading that page
      expect(page.text).toContain(`<a href="/-/config/sources/team/${path}?run=1">`);
    }
    expect(lookup).not.toHaveBeenCalled();

    // The run address answers with the finished panel under the same key, which the island swaps in
    const run = await ready('/-/config/sources/team/check?run=1').expect(200);
    expect(run.text).toContain('data-spr-defer-key="check:team">');
    expect(run.text).toContain('data-spr-repo-state="unpublished"');
  });
});

describe('a check GitHub does not answer', () => {
  const timeout = (): never => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  };

  it('says which step stopped, and which request GitHub did not answer', async () => {
    await createOnGithub('sources', 'team');
    const answer = lookup.getMockImplementation()!;
    lookup.mockImplementation(async (input, init) =>
      new URL(String(input)).pathname === '/app/installations' ? timeout() : answer(input, init),
    );
    const page = await ready('/-/config/sources/team/check?run=1').expect(200);
    expect(page.text).toContain(
      'Could not find the App&#39;s installation on acme: GitHub did not answer GET https://api.github.com/app/installations?per_page=100&amp;page=1 within 5 s.',
    );
  });

  it('says why one repository could not be read, and checks the others', async () => {
    await createOnGithub('sources', 'team');
    installations = [{ id: 5, account: { login: 'acme' }, repository_selection: 'all' }];
    repos = { slow: { 'README.md': '' }, wiki: { 'README.md': '' } };
    const answer = lookup.getMockImplementation()!;
    lookup.mockImplementation(async (input, init) =>
      String(input).includes('/repos/acme/slow/git/trees/') ? timeout() : answer(input, init),
    );
    const page = await ready('/-/config/sources/team/check?run=1').expect(200);
    const states = [...page.text.matchAll(/data-spr-repo-state="([a-z-]+)"/g)].map((m) => m[1]);
    expect(states).toEqual(['unreadable', 'unpublished']);
    expect(page.text).toContain(
      'GitHub could not be asked for its files: GitHub did not answer GET https://api.github.com/repos/acme/slow/git/trees/main?recursive=1 within 15 s',
    );
  });
});

describe('creating the groups the repositories of a source name', () => {
  const INSTALLED = [{ id: 5, account: { login: 'acme' }, repository_selection: 'all' }];
  const NAMING = {
    notes: { '.speicher.yaml': 'version: 1\naccess:\n  groups: [enginering, contractors]\n' },
    wiki: { '.speicher.yaml': 'version: 1\naccess:\n  groups: [contractors]\n' },
  };

  /** A source whose repositories name a typo of `engineering`, and `contractors`, which does not exist */
  async function sourceNamingGroups(): Promise<void> {
    await createOnGithub('sources', 'team');
    installations = INSTALLED;
    repos = NAMING;
  }

  function post(fields: Record<string, string | string[]>) {
    return request(app.getHttpServer())
      .post('/-/config/sources/team/groups')
      .set('cookie', ops)
      .type('form')
      .send(fields);
  }

  it('leads on from the check when the repositories name groups that do not exist', async () => {
    await sourceNamingGroups();
    const page = await ready('/-/config/sources/team/check?run=1').expect(200);
    expect(page.text).toMatch(
      /href="\/-\/config\/sources\/team\/groups" data-spr-ready-primary>Create 2 missing groups/,
    );
  });

  it('lists each missing group once, leaving a likely typo unticked, with one switch to join them', async () => {
    await sourceNamingGroups();
    const page = await ready('/-/config/sources/team/groups?run=1').expect(200);
    expect(page.text).toContain('<details class="spr-modal spr-groups-modal" open>');
    expect(page.text).toContain('Used by acme/notes, acme/wiki');
    expect(page.text).toContain('name="create" value="contractors" checked');
    expect(page.text).toMatch(/name="create" value="enginering">/);
    expect(page.text).toContain('Did you mean <code>engineering</code>?');
    expect(page.text).toContain('name="add_me" value="on" checked');
  });

  it('creates the ticked groups with the person creating them in each', async () => {
    await sourceNamingGroups();
    await post({ create: ['contractors', 'enginering'], add_me: 'on' })
      .expect(303)
      .expect('location', '/-/config/sources/team/check');
    const groups = (await stored()).groups;
    for (const name of ['contractors', 'enginering']) {
      expect(groups[name]).toEqual([
        expect.objectContaining({ provider: 'entra', subject: PRINCIPALS.ops.oid }),
      ]);
    }

    const back = await ready('/-/config/sources/team/check?run=1').expect(200);
    // wiki only named contractors, which exists now
    expect(back.text).toMatch(/acme\/wiki<\/a>\s*<span class="spr-check-found">Readable by/);
  });

  it('creates them empty when the switch is off, and leaves a group that exists alone', async () => {
    await sourceNamingGroups();
    await post({ create: ['contractors', 'engineering'] })
      .expect(303)
      .expect('location', '/-/config/sources/team/check');
    const groups = (await stored()).groups;
    expect(groups.contractors).toEqual([]);
    expect(groups.engineering).toEqual([{ provider: 'entra', id: 'grp-eng' }]);
  });

  it('refuses a name that is not a group name, and keeps the modal open', async () => {
    await sourceNamingGroups();
    const page = await post({ create: ['not a name'], add_me: 'on' }).expect(400);
    expect(page.text).toContain('is not a group name');
    expect(page.text).toContain('<details class="spr-modal spr-groups-modal" open>');
  });

  it('says so once no group is missing', async () => {
    await createOnGithub('sources', 'team');
    installations = INSTALLED;
    repos = { wiki: { '.speicher.yaml': 'version: 1\naccess:\n  groups: [engineering]\n' } };
    const page = await ready('/-/config/sources/team/groups?run=1').expect(200);
    expect(page.text).toContain('Every group your repositories name exists already.');
    expect(page.text).not.toContain('name="create"');
  });
});

describe('the ready page', () => {
  it('sends a member set up on its page to that page', async () => {
    await ready('/-/config/identity/entra/ready')
      .expect(303)
      .expect('location', '/-/config/identity/entra');
  });

  it('answers 404 for a member that is not stored', async () => {
    await ready('/-/config/identity/nobody/ready').expect(404);
  });
});
