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
} from '../../src/config/loader';
import {
  GITHUB_APP_FORM_COOKIE,
  GITHUB_APP_HANDOFF_COOKIE,
  GithubAppManifestService,
} from '../../src/dashboard/configurator/config-page/github-app-manifest';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import type { AppManifest } from '../../src/github/app-manifest';
import { FormBody, formBody } from '../helpers/form';
import { Harness, createHarness } from '../helpers/harness';
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
const github = jest.fn<Promise<Response>, Parameters<typeof fetch>>();

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
    ],
  );
});

beforeEach(async () => {
  await resetVersions();
  ops = await sessionCookieFor(harness.tenantId, 'ops');
  github.mockReset();
  github.mockImplementation(async () => new Response(JSON.stringify(CONVERTED), { status: 201 }));
});

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

async function stored(): Promise<{ version: number; doc: Record<string, any> }> {
  const row = await getNewestConfigVersion(harness.tenantId);
  return { version: row!.version, doc: parse(row!.yaml) as Record<string, any> };
}

/** Opens the page of a GitHub source or provider that is not stored yet, and returns its form */
async function openNewSource(id: string, section = 'sources'): Promise<FormBody> {
  const page = await request(app.getHttpServer())
    .get(`/-/config/${section}/${id}?kind=github`)
    .set('cookie', ops)
    .expect(200);
  return formBody(page.text);
}

/** Opens the page of a stored provider, and returns its form */
async function openProvider(id: string): Promise<FormBody> {
  const page = await request(app.getHttpServer())
    .get(`/-/config/identity/${id}`)
    .set('cookie', ops)
    .expect(200);
  return formBody(page.text);
}

/** Posts a form as the page's multipart form posts it */
function postForm(path: string, body: FormBody) {
  let req = request(app.getHttpServer()).post(path).set('cookie', ops);
  for (const [name, value] of Object.entries(body)) {
    for (const one of Array.isArray(value) ? value : [value]) req = req.field(name, one);
  }
  return req;
}

/**
 * Presses the button that creates the App, with the form as the page holds it. A start that is taken redirects to
 * the page that posts the manifest to GitHub; expecting 200 follows it, and answers with that page and the cookies
 * the start set.
 */
function startFlow(id: string, body: FormBody, section = 'sources', appSegment = 'github-app') {
  const account = body['github-app:owner'] ? 'org' : 'personal';
  const asked = 'github-app:account' in body ? { ...body, 'github-app:account': account } : body;
  const posted = postForm(`/-/config/${section}/${id}/${appSegment}/manifest`, asked);
  return {
    expect: async (status: number): Promise<request.Response> => {
      if (status !== 200) return posted.expect(status);
      return followHandoff(await posted.expect(303));
    },
  };
}

/** Opens the page a start redirected to, as the browser does, with the cookies the start set */
async function followHandoff(started: request.Response): Promise<request.Response> {
  const cookies = ([] as string[]).concat(started.headers['set-cookie'] ?? []);
  const handoff = cookies.find((each) => each.startsWith(`${GITHUB_APP_HANDOFF_COOKIE}=`));
  if (!handoff) throw new Error('the start set no hand-off cookie');
  const page = await request(app.getHttpServer())
    .get(started.headers.location)
    .set('cookie', `${ops}; ${handoff.split(';')[0]}`)
    .expect(200);
  // The start's cookies stay readable on what the start answered with
  page.headers['set-cookie'] = started.headers['set-cookie'];
  return page;
}

/** The page on GitHub the hand-off posts its manifest to */
function manifestPostUrl(html: string): URL {
  const action = /<form method="post" action="([^"]+)"/.exec(html)?.[1];
  if (!action) throw new Error('the page has no form that posts the manifest');
  return new URL(action.replace(/&amp;/g, '&'));
}

/** The manifest the hand-off posts to GitHub */
function manifestOf(html: string): AppManifest {
  const value = /name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? '';
  return JSON.parse(value.replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as AppManifest;
}

/** The cookie that carries the page's form while the browser is on GitHub, as the start set it */
function formCookie(response: request.Response): string {
  const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
  const cookie = cookies.find((each) => each.startsWith(`${GITHUB_APP_FORM_COOKIE}=`));
  if (!cookie) throw new Error('the start set no form cookie');
  return cookie;
}

/** Comes back from GitHub, with the cookie the start set unless another is given */
function callback(
  id: string,
  query: string,
  cookie: string | null,
  section = 'sources',
  appSegment = 'github-app',
) {
  const cookies = cookie === null ? ops : `${ops}; ${cookie.split(';')[0]}`;
  return request(app.getHttpServer())
    .get(`/-/config/${section}/${id}/${appSegment}/manifest/callback?${query}`)
    .set('cookie', cookies);
}

/** Starts a flow from a page, and returns its state and cookie */
async function started(
  id: string,
  form: FormBody,
  section = 'sources',
  appSegment = 'github-app',
): Promise<{ state: string; cookie: string }> {
  const response = await startFlow(id, form, section, appSegment).expect(200);
  return {
    state: manifestPostUrl(response.text).searchParams.get('state')!,
    cookie: formCookie(response),
  };
}

/** Creates the sign-in App of a new provider, which stores the provider */
async function storeProvider(id: string): Promise<void> {
  const { state, cookie } = await started(id, await openNewSource(id, 'identity'), 'identity');
  await callback(id, `code=sign-in&state=${state}`, cookie, 'identity').expect(303);
  github.mockClear();
}

describe('creating the GitHub App of a new source from a manifest', () => {
  it('hands the manifest over to GitHub, and stores nothing yet', async () => {
    const before = (await stored()).version;
    const response = await startFlow('team', {
      ...(await openNewSource('team')),
      'github-app:owner': 'acme',
    }).expect(200);

    const target = manifestPostUrl(response.text);
    expect(`${target.origin}${target.pathname}`).toBe(
      'https://github.com/organizations/acme/settings/apps/new',
    );
    expect(target.searchParams.get('state')).toBeTruthy();
    // The page's form may post to GitHub, and nowhere else outside this instance
    expect(response.headers['content-security-policy']).toContain(
      "form-action 'self' https://github.com",
    );
    // The form submits itself, with a script the CSP lets run
    const nonce = /'nonce-([^']+)'/.exec(response.headers['content-security-policy'])?.[1];
    expect(response.text).toContain(
      `<script nonce="${nonce}">document.forms[0].submit();</script>`,
    );

    const manifest = manifestOf(response.text);
    expect(manifest.redirect_url).toMatch(
      /\/-\/config\/sources\/team\/github-app\/manifest\/callback$/,
    );
    // The test instance answers on 127.0.0.1, which GitHub cannot reach
    expect(manifest.hook_attributes).toBeUndefined();
    expect(manifest.default_events).toEqual([]);

    // Only the callback reads the cookie
    expect(formCookie(response)).toContain(
      'Path=/-/config/sources/team/github-app/manifest/callback',
    );
    const after = await stored();
    expect(after.version).toBe(before);
    expect(after.doc.forges.team).toBeUndefined();
  });

  it('gives the App a webhook when the instance has a public URL', async () => {
    const before = process.env.SPEICHER_PUBLIC_URL;
    process.env.SPEICHER_PUBLIC_URL = 'https://docs.acme.example';
    try {
      const response = await startFlow('team', await openNewSource('team')).expect(200);
      const manifest = manifestOf(response.text);
      expect(manifest.hook_attributes).toEqual({
        url: 'https://docs.acme.example/-/hooks/forge/team',
        active: true,
      });
      expect(manifest.redirect_url).toBe(
        'https://docs.acme.example/-/config/sources/team/github-app/manifest/callback',
      );
    } finally {
      if (before === undefined) delete process.env.SPEICHER_PUBLIC_URL;
      else process.env.SPEICHER_PUBLIC_URL = before;
    }
  });

  it('gives the App a webhook on a private address too, which only localhost is refused', async () => {
    const before = process.env.SPEICHER_PUBLIC_URL;
    process.env.SPEICHER_PUBLIC_URL = 'http://speicher.internal';
    try {
      const page = await request(app.getHttpServer())
        .get('/-/config/sources/team?kind=github')
        .set('cookie', ops)
        .expect(200);
      expect(page.text).toContain('may not be able to reach');

      const response = await startFlow('team', formBody(page.text)).expect(200);
      expect(manifestOf(response.text).hook_attributes).toEqual({
        url: 'http://speicher.internal/-/hooks/forge/team',
        active: true,
      });
    } finally {
      if (before === undefined) delete process.env.SPEICHER_PUBLIC_URL;
      else process.env.SPEICHER_PUBLIC_URL = before;
    }
  });

  it('creates the App on the personal account when no organization is given', async () => {
    const response = await startFlow('team', await openNewSource('team')).expect(200);
    expect(manifestPostUrl(response.text).pathname).toBe('/settings/apps/new');
  });

  it('asks whose account the App goes on, as the add modal does', async () => {
    const page = await request(app.getHttpServer())
      .get('/-/config/sources/team?kind=github')
      .set('cookie', ops)
      .expect(200);

    expect(page.text).toContain('<legend>Which repositories do you want to sync</legend>');
    expect(page.text).toMatch(/name="github-app:account" value="org" checked/);
    expect(page.text).toContain('data-spr-shown-with="github-app:account"');
    expect(page.text).toContain('Continue on GitHub<svg');
    expect(page.text).not.toContain('Create the App on GitHub');
  });

  it('refuses an organization without a name, as the add modal does', async () => {
    const refused = await postForm('/-/config/sources/team/github-app/manifest', {
      ...(await openNewSource('team')),
      'github-app:account': 'org',
      'github-app:owner': ' ',
    }).expect(400);
    expect(refused.text).toContain('Name the organization the App is created on.');
  });

  it('forgets the organization typed before the personal account was picked', async () => {
    const posted = await postForm('/-/config/sources/team/github-app/manifest', {
      ...(await openNewSource('team')),
      'github-app:account': 'personal',
      'github-app:owner': 'acme',
    }).expect(303);
    const response = await followHandoff(posted);
    expect(manifestPostUrl(response.text).pathname).toBe('/settings/apps/new');
  });

  it('opens on entering the details when the add modal was left with Configure manually', async () => {
    const redirected = await request(app.getHttpServer())
      .get('/-/config/sources?add=team&kind=github&setup=manual')
      .set('cookie', ops)
      .expect(303);
    expect(redirected.headers.location).toBe('/-/config/sources/team?kind=github&setup=manual');

    const manual = await request(app.getHttpServer())
      .get(redirected.headers.location)
      .set('cookie', ops)
      .expect(200);
    expect(manual.text).toMatch(/value="manual"\s+checked/);
    expect(manual.text).not.toMatch(/value="create"\s+checked/);
  });

  it('saves the source with the App and the values typed on the page, then installs the App', async () => {
    const { state, cookie } = await started('team', {
      ...(await openNewSource('team')),
      'forges.team.default_repository_owner': 'copetence-docs',
    });

    const back = await callback('team', `code=the-code&state=${state}`, cookie).expect(303);
    // GitHub sends the browser to the ready modal once the App is installed
    expect(back.headers.location).toBe(INSTALL_URL);
    expect(github).toHaveBeenCalledWith(
      'https://api.github.com/app-manifests/the-code/conversions',
      expect.objectContaining({ method: 'POST' }),
    );

    const team = (await stored()).doc.forges.team;
    expect(team.type).toBe('github');
    expect(team.default_repository_owner).toBe('copetence-docs');
    expect(team.app_id).toBe('4242');
    // The form trims the key's last newline, as it trims a key pasted into it
    expect(team.private_key).toBe(PEM.trim());
    expect(team.webhook_secret).toBe('from-github');
  });

  it('leaves the default repository owner as the page has it, which a quick setup would fill in', async () => {
    const { state, cookie } = await started('team', await openNewSource('team'));
    await callback('team', `code=the-code&state=${state}`, cookie).expect(303);
    expect((await stored()).doc.forges.team.default_repository_owner).toBeUndefined();
  });

  it('stores no webhook secret when GitHub created the App without a webhook, and says so', async () => {
    github.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ...CONVERTED, webhook_secret: null }), { status: 201 }),
    );
    const { state, cookie } = await started('team', await openNewSource('team'));
    await callback('team', `code=the-code&state=${state}`, cookie).expect(303);

    const team = (await stored()).doc.forges.team;
    expect(team.app_id).toBe(String(CONVERTED.id));
    expect(team.webhook_secret).toBeUndefined();

    const page = await request(app.getHttpServer())
      .get('/-/config/sources/team')
      .set('cookie', ops)
      .expect(200);
    expect(page.text).toContain('This source has no webhook secret');
  });

  it('creates the App on the GitHub Enterprise Server the page names', async () => {
    const { state, cookie } = await started('team', {
      ...(await openNewSource('team')),
      'forges.team.base_url': 'https://ghe.example.test',
    });

    await callback('team', `code=the-code&state=${state}`, cookie).expect(303);
    expect(github).toHaveBeenCalledWith(
      'https://ghe.example.test/api/v3/app-manifests/the-code/conversions',
      expect.anything(),
    );
    expect((await stored()).doc.forges.team.base_url).toBe('https://ghe.example.test');
  });

  it('carries the form sealed, so the cookie shows nothing typed on the page', async () => {
    const response = await startFlow('team', {
      ...(await openNewSource('team')),
      'forges.team.default_repository_owner': 'visible-owner',
    }).expect(200);
    const value = formCookie(response).split(';')[0];
    expect(value).not.toContain('visible-owner');
    expect(Buffer.from(value.split('=')[1], 'base64url').toString('latin1')).not.toContain(
      'visible-owner',
    );
  });

  it('posts the manifest from a page reached by a redirect, which Back from GitHub leads past', async () => {
    const posted = await postForm('/-/config/sources/team/github-app/manifest', {
      ...(await openNewSource('team')),
      'github-app:owner': 'acme',
    }).expect(303);
    expect(posted.headers.location).toBe('/-/config/sources/team/github-app/manifest/handoff');
    await followHandoff(posted);

    // Asked again, as Back from GitHub asks, the page leads to the new source's form instead
    await request(app.getHttpServer())
      .get(posted.headers.location)
      .set('cookie', ops)
      .expect(303)
      .expect('location', '/-/config/sources/team?kind=github');
  });

  it("leads Back to a stored provider's own page", async () => {
    await storeProvider('octo');
    await request(app.getHttpServer())
      .get('/-/config/identity/octo/github-directory-app/manifest/handoff')
      .set('cookie', ops)
      .expect(303)
      .expect('location', '/-/config/identity/octo');
  });

  it('posts nothing to GitHub from a hand-off cookie that was changed', async () => {
    const posted = await postForm('/-/config/sources/team/github-app/manifest', {
      ...(await openNewSource('team')),
      'github-app:account': 'personal',
    }).expect(303);
    const handoff = ([] as string[])
      .concat(posted.headers['set-cookie'] ?? [])
      .find((each) => each.startsWith(`${GITHUB_APP_HANDOFF_COOKIE}=`))!
      .split(';')[0];
    await request(app.getHttpServer())
      .get(posted.headers.location)
      .set('cookie', `${ops}; ${handoff.slice(0, -2)}AA`)
      .expect(303)
      .expect('location', '/-/config/sources/team?kind=github');
  });

  it('refuses a cookie that was changed', async () => {
    const { state, cookie } = await started('team', await openNewSource('team'));
    const [pair, ...attributes] = cookie.split(';');
    const changed = `${pair.slice(0, -2)}AA;${attributes.join(';')}`;
    const back = await callback('team', `code=the-code&state=${state}`, changed).expect(400);
    expect(back.text).toContain('without the details this page sent along');
    expect(github).not.toHaveBeenCalled();
  });

  it('refuses a state it did not hand out, or one it has used', async () => {
    const { state, cookie } = await started('team', await openNewSource('team'));

    const unknown = await callback('team', 'code=the-code&state=made-up', cookie).expect(400);
    expect(unknown.text).toContain('does not match an open request from this page');
    expect(github).not.toHaveBeenCalled();

    await callback('team', `code=the-code&state=${state}`, cookie).expect(303);
    await callback('team', `code=the-code&state=${state}`, cookie).expect(400);
    expect(github).toHaveBeenCalledTimes(1);
  });

  it('refuses a state handed out for another source', async () => {
    const { state, cookie } = await started('team', await openNewSource('team'));
    await callback('other', `code=the-code&state=${state}`, cookie).expect(400);
    expect(github).not.toHaveBeenCalled();
  });

  it('refuses to come back without the cookie the start set', async () => {
    const { state } = await started('team', await openNewSource('team'));
    const back = await callback('team', `code=the-code&state=${state}`, null).expect(400);
    expect(back.text).toContain('without the details this page sent along');
    expect(github).not.toHaveBeenCalled();
  });

  it('refuses to take the App over for a source that is already stored', async () => {
    const { state, cookie } = await started('gh', await openNewSource('gh'));
    const back = await callback('gh', `code=the-code&state=${state}`, cookie).expect(400);
    expect(back.text).toContain('already exists');
    expect(github).not.toHaveBeenCalled();
  });
});

describe('creating the GitHub App of a new identity provider from a manifest', () => {
  it('hands a sign-in App over to GitHub, and stores nothing yet', async () => {
    const before = (await stored()).version;
    const response = await startFlow(
      'octo',
      { ...(await openNewSource('octo', 'identity')), 'github-app:owner': 'acme' },
      'identity',
    ).expect(200);

    expect(manifestPostUrl(response.text).pathname).toBe('/organizations/acme/settings/apps/new');
    const manifest = manifestOf(response.text);
    // Named after the host of this instance, which answers the test on 127.0.0.1
    expect(manifest.name).toBe('127.0.0.1 Speicher.md');
    expect(manifest.callback_urls?.[0]).toMatch(/\/api\/auth\/github\/callback$/);
    expect(manifest.redirect_url).toMatch(
      /\/-\/config\/identity\/octo\/github-app\/manifest\/callback$/,
    );
    expect(manifest.hook_attributes).toBeUndefined();
    expect(manifest.default_permissions).toEqual({ members: 'read', emails: 'read' });
    expect((await stored()).version).toBe(before);
  });

  it('saves the provider with its client id and secret, then installs the App on its organization', async () => {
    const { state, cookie } = await started(
      'octo',
      {
        ...(await openNewSource('octo', 'identity')),
        'auth.providers.octo.display_name': 'Octo staff',
      },
      'identity',
    );
    const back = await callback('octo', `code=the-code&state=${state}`, cookie, 'identity').expect(
      303,
    );
    // Through the start that lets the installation's return sign the person in
    expect(back.headers.location).toBe('/-/config/identity/octo/install');

    const octo = (await stored()).doc.auth.providers.octo;
    expect(octo.type).toBe('github');
    expect(octo.display_name).toBe('Octo staff');
    expect(octo.client_id).toBe('Iv1.abc');
    expect(octo.client_secret).toBe('secret');
    expect(octo.app).toEqual({
      client_id: 'Iv1.abc',
      slug: 'speicher-md',
      owner_account: 'acme',
      owner_is_organization: true,
    });

    const page = await request(app.getHttpServer())
      .get('/-/config/identity/octo')
      .set('cookie', ops)
      .expect(200);
    expect(page.text).toContain(
      'href="https://github.com/organizations/acme/settings/apps/speicher-md"',
    );
    expect(page.text).toContain(`href="${INSTALL_URL}"`);
  });

  it('saves the provider under the short id it was added with', async () => {
    const response = await startFlow(
      'octo',
      await openNewSource('octo', 'identity'),
      'identity',
    ).expect(200);
    // After the App is installed, GitHub sends the browser to the provider's ready page
    expect(manifestOf(response.text).setup_url).toMatch(/\/-\/config\/identity\/octo\/ready$/);

    const state = manifestPostUrl(response.text).searchParams.get('state')!;
    await callback('octo', `code=the-code&state=${state}`, formCookie(response), 'identity').expect(
      303,
    );
    expect((await stored()).doc.auth.providers.octo.client_id).toBe('Iv1.abc');
  });

  it('shows the page with the App kept in it when the save is refused', async () => {
    // The session lifetime is not a duration, so the save refuses it
    const { state, cookie } = await started(
      'octo',
      {
        ...(await openNewSource('octo', 'identity')),
        'auth.providers.octo.session_ttl': 'forever',
      },
      'identity',
    );

    const back = await callback('octo', `code=the-code&state=${state}`, cookie, 'identity').expect(
      400,
    );
    expect(back.text).toContain('could not be saved yet');
    expect(back.text).toContain(`href="${INSTALL_URL}"`);
    expect(back.text).toContain('value="Iv1.abc"');
    expect(back.text).toContain('name="unsaved:auth.providers.octo.client_secret"');
    expect((await stored()).doc.auth.providers.octo).toBeUndefined();
  });

  it('refuses to take the App over for a provider that is already stored', async () => {
    const { state, cookie } = await started('entra', await openProvider('entra'), 'identity');
    const back = await callback('entra', `code=the-code&state=${state}`, cookie, 'identity').expect(
      400,
    );
    expect(back.text).toContain('already exists');
    expect(github).not.toHaveBeenCalled();
  });

  it('answers 404 for a section that has no GitHub App', async () => {
    await startFlow('engineering', {}, 'groups').expect(404);
  });
});

describe('creating the directory App of an identity provider from a manifest', () => {
  it('hands a directory App over to GitHub', async () => {
    await storeProvider('octo');
    const response = await startFlow(
      'octo',
      { ...(await openProvider('octo')), 'github-directory-app:owner': 'acme' },
      'identity',
      'github-directory-app',
    ).expect(200);

    expect(manifestPostUrl(response.text).pathname).toBe('/organizations/acme/settings/apps/new');
    const manifest = manifestOf(response.text);
    expect(manifest.name).toBe('Speicher.md Directory');
    expect(manifest.default_permissions).toEqual({ members: 'read' });
    expect(manifest.callback_urls).toBeUndefined();
    expect(manifest.redirect_url).toMatch(
      /\/-\/config\/identity\/octo\/github-directory-app\/manifest\/callback$/,
    );
    // The test instance answers on 127.0.0.1, which GitHub refuses as a webhook
    expect(manifest.hook_attributes).toBeUndefined();
  });

  it('gives the directory App a webhook for team changes when the instance has a public URL', async () => {
    await storeProvider('octo');
    const before = process.env.SPEICHER_PUBLIC_URL;
    process.env.SPEICHER_PUBLIC_URL = 'https://docs.acme.example';
    try {
      const response = await startFlow(
        'octo',
        await openProvider('octo'),
        'identity',
        'github-directory-app',
      ).expect(200);
      const manifest = manifestOf(response.text);
      expect(manifest.hook_attributes).toEqual({
        url: 'https://docs.acme.example/-/hooks/directory/octo',
        active: true,
      });
      expect(manifest.default_events).toEqual(['membership', 'team', 'organization']);
    } finally {
      if (before === undefined) delete process.env.SPEICHER_PUBLIC_URL;
      else process.env.SPEICHER_PUBLIC_URL = before;
    }
  });

  it("saves the stored provider's directory lookup, and keeps its sign-in App", async () => {
    await storeProvider('octo');
    const { state, cookie } = await started(
      'octo',
      await openProvider('octo'),
      'identity',
      'github-directory-app',
    );

    const back = await callback(
      'octo',
      `code=directory&state=${state}`,
      cookie,
      'identity',
      'github-directory-app',
    ).expect(303);
    // The directory App is installed next; the ready page lists the sign-in App's steps
    expect(back.headers.location).toBe(INSTALL_URL);
    const octo = (await stored()).doc.auth.providers.octo;
    expect(octo.client_id).toBe('Iv1.abc');
    expect(octo.directory).toMatchObject({
      type: 'github',
      app_id: '4242',
      webhook_secret: 'from-github',
    });
    expect(octo.directory.private_key).toBe(PEM.trim());
  });

  it('saves a new provider with the directory App and a sign-in App typed in manually', async () => {
    const { state, cookie } = await started(
      'octo',
      {
        ...(await openNewSource('octo', 'identity')),
        'choice:auth.providers.octo.app': 'manual',
        'auth.providers.octo.client_id': 'Iv1.manual',
        'auth.providers.octo.client_secret': 'typed',
      },
      'identity',
      'github-directory-app',
    );

    await callback(
      'octo',
      `code=directory&state=${state}`,
      cookie,
      'identity',
      'github-directory-app',
    ).expect(303);
    const octo = (await stored()).doc.auth.providers.octo;
    expect(octo.client_id).toBe('Iv1.manual');
    expect(octo.client_secret).toBe('typed');
    expect(octo.directory).toMatchObject({ type: 'github', app_id: '4242' });
  });

  it("refuses the state of the provider's sign-in App", async () => {
    await storeProvider('octo');
    const { state, cookie } = await started(
      'fresh',
      await openNewSource('fresh', 'identity'),
      'identity',
    );
    await callback(
      'octo',
      `code=directory&state=${state}`,
      cookie,
      'identity',
      'github-directory-app',
    ).expect(400);
    expect(github).not.toHaveBeenCalled();
  });
});
