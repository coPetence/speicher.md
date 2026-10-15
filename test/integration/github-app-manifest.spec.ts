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
  GITHUB_APP_BASE_URL_COOKIE,
  GithubAppManifestService,
} from '../../src/dashboard/configurator/config-page/github-app-manifest';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import type { AppManifest } from '../../src/forge/github/manifest';
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
  html_url: 'https://github.com/apps/speicher-md',
  pem: PEM,
  webhook_secret: 'from-github',
  client_id: 'Iv1.abc',
  client_secret: 'secret',
};

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

/** Posts a form as the page's multipart form posts it */
function postForm(path: string, body: FormBody) {
  let req = request(app.getHttpServer()).post(path).set('cookie', ops);
  for (const [name, value] of Object.entries(body)) {
    for (const one of Array.isArray(value) ? value : [value]) req = req.field(name, one);
  }
  return req;
}

/** Presses the button that creates the App, with the form as the page holds it */
function startFlow(id: string, body: FormBody, section = 'sources', app = 'github-app') {
  return postForm(`/-/config/${section}/${id}/${app}/manifest`, body);
}

/** The page on GitHub the hand-off page posts its manifest to */
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

/** The cookie that holds the base URL while the browser is on GitHub, as the start set it */
function baseUrlCookie(started: request.Response): string {
  const cookies = ([] as string[]).concat(started.headers['set-cookie'] ?? []);
  const cookie = cookies.find((each) => each.startsWith(`${GITHUB_APP_BASE_URL_COOKIE}=`));
  if (!cookie) throw new Error('the start set no base URL cookie');
  return cookie;
}

/** Comes back from GitHub, with the cookie the start set unless one is given */
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

/** Starts a flow for a new source or provider, and returns its state and cookie */
async function started(
  id: string,
  body: FormBody = {},
  section = 'sources',
): Promise<{ state: string; cookie: string }> {
  const response = await startFlow(
    id,
    { ...(await openNewSource(id, section)), ...body },
    section,
  ).expect(200);
  return {
    state: manifestPostUrl(response.text).searchParams.get('state')!,
    cookie: baseUrlCookie(response),
  };
}

describe('creating the GitHub App of a new source from a manifest', () => {
  it('hands the manifest over to GitHub, and stores nothing', async () => {
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
    expect(baseUrlCookie(response)).toContain(
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
        url: 'https://docs.acme.example/-/hooks/team',
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

  it('creates the App on the personal account when no organization is given', async () => {
    const response = await startFlow('team', await openNewSource('team')).expect(200);
    expect(manifestPostUrl(response.text).pathname).toBe('/settings/apps/new');
  });

  it('fills the page with the App, and leaves the save to the person', async () => {
    const before = (await stored()).version;
    const { state, cookie } = await started('team');

    const back = await callback('team', `code=the-code&state=${state}`, cookie).expect(200);
    expect(github).toHaveBeenCalledWith(
      'https://api.github.com/app-manifests/the-code/conversions',
      expect.objectContaining({ method: 'POST' }),
    );
    // The note links to where the App is installed on the repositories
    expect(back.text).toContain('href="https://github.com/apps/speicher-md/installations/new"');
    expect(back.text).toContain('value="4242"');
    expect(back.text).toContain('name="unsaved:forges.team.webhook_secret"');
    expect((await stored()).version).toBe(before);

    // Saving the page stores the source with the App's credentials
    await postForm('/-/config/sources/team?kind=github', {
      ...formBody(back.text),
      intent: 'apply',
    }).expect(303);
    const team = (await stored()).doc.forges.team;
    expect(team.type).toBe('github');
    expect(team.app_id).toBe('4242');
    // The form trims the key's last newline, as it trims a key pasted into it
    expect(team.private_key).toBe(PEM.trim());
    expect(team.webhook_secret).toBe('from-github');
  });

  it('gives the source a webhook secret when GitHub created the App without a webhook', async () => {
    github.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ...CONVERTED, webhook_secret: null }), { status: 201 }),
    );
    const { state, cookie } = await started('team');
    const back = await callback('team', `code=the-code&state=${state}`, cookie).expect(200);

    await postForm('/-/config/sources/team?kind=github', {
      ...formBody(back.text),
      intent: 'apply',
    }).expect(303);
    expect((await stored()).doc.forges.team.webhook_secret).toEqual(expect.any(String));
  });

  it('creates the App on the GitHub Enterprise Server the page names', async () => {
    const { state, cookie } = await started('team', {
      'forges.team.base_url': 'https://ghe.example.test',
    });

    const back = await callback('team', `code=the-code&state=${state}`, cookie).expect(200);
    expect(github).toHaveBeenCalledWith(
      'https://ghe.example.test/api/v3/app-manifests/the-code/conversions',
      expect.anything(),
    );
    expect(back.text).toContain('value="https://ghe.example.test"');
  });

  it('refuses a state it did not hand out, or one it has used', async () => {
    const { state, cookie } = await started('team');

    const unknown = await callback('team', 'code=the-code&state=made-up', cookie).expect(400);
    expect(unknown.text).toContain('Speicher does not know this answer from GitHub');
    expect(github).not.toHaveBeenCalled();

    await callback('team', `code=the-code&state=${state}`, cookie).expect(200);
    await callback('team', `code=the-code&state=${state}`, cookie).expect(400);
    expect(github).toHaveBeenCalledTimes(1);
  });

  it('refuses a state handed out for another source', async () => {
    const { state, cookie } = await started('team');
    await callback('other', `code=the-code&state=${state}`, cookie).expect(400);
    expect(github).not.toHaveBeenCalled();
  });

  it('refuses to come back without the cookie the start set', async () => {
    const { state } = await started('team');
    const back = await callback('team', `code=the-code&state=${state}`, null).expect(400);
    expect(back.text).toContain('without the details this page sent along');
    expect(github).not.toHaveBeenCalled();
  });

  it('refuses to fill in a source that is already stored', async () => {
    const { state, cookie } = await started('gh');
    const back = await callback('gh', `code=the-code&state=${state}`, cookie).expect(400);
    expect(back.text).toContain('already exists');
    expect(github).not.toHaveBeenCalled();
  });
});

describe('creating the GitHub App of a new identity provider from a manifest', () => {
  it('hands a sign-in App over to GitHub, and stores nothing', async () => {
    const before = (await stored()).version;
    const response = await startFlow(
      'octo',
      { ...(await openNewSource('octo', 'identity')), 'github-app:owner': 'acme' },
      'identity',
    ).expect(200);

    expect(manifestPostUrl(response.text).pathname).toBe('/organizations/acme/settings/apps/new');
    const manifest = manifestOf(response.text);
    expect(manifest.name).toBe('Speicher.md OAuth');
    expect(manifest.callback_urls?.[0]).toMatch(/\/api\/auth\/github\/callback$/);
    expect(manifest.redirect_url).toMatch(
      /\/-\/config\/identity\/octo\/github-app\/manifest\/callback$/,
    );
    expect(manifest.hook_attributes).toBeUndefined();
    expect(manifest.default_permissions).toEqual({ members: 'read', emails: 'read' });
    expect((await stored()).version).toBe(before);
  });

  it('fills the page with the client id and secret, and saving stores the provider', async () => {
    const { state, cookie } = await started('octo', {}, 'identity');
    const back = await callback('octo', `code=the-code&state=${state}`, cookie, 'identity').expect(
      200,
    );
    expect(back.text).toContain('href="https://github.com/apps/speicher-md/installations/new"');
    expect(back.text).toContain('value="Iv1.abc"');

    await postForm('/-/config/identity/octo?kind=github', {
      ...formBody(back.text),
      intent: 'apply',
    }).expect(303);
    const octo = (await stored()).doc.auth.providers.octo;
    expect(octo.type).toBe('github');
    expect(octo.client_id).toBe('Iv1.abc');
    expect(octo.client_secret).toBe('secret');
  });

  it('refuses to fill in a provider that is already stored', async () => {
    const { state, cookie } = await started('entra', {}, 'identity');
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

describe('creating the directory App of a stored identity provider from a manifest', () => {
  /** Opens the page of a stored provider, and returns its form */
  async function openProvider(id: string): Promise<FormBody> {
    const page = await request(app.getHttpServer())
      .get(`/-/config/identity/${id}`)
      .set('cookie', ops)
      .expect(200);
    return formBody(page.text);
  }

  /** Stores a GitHub provider whose App GitHub created */
  async function storeProvider(id: string): Promise<void> {
    const { state, cookie } = await started(id, {}, 'identity');
    const back = await callback(id, `code=sign-in&state=${state}`, cookie, 'identity').expect(200);
    await postForm(`/-/config/identity/${id}?kind=github`, {
      ...formBody(back.text),
      intent: 'apply',
    }).expect(303);
    github.mockClear();
  }

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
  });

  it("fills the stored provider's directory lookup, and saving stores it", async () => {
    await storeProvider('octo');
    const response = await startFlow(
      'octo',
      await openProvider('octo'),
      'identity',
      'github-directory-app',
    ).expect(200);
    const state = manifestPostUrl(response.text).searchParams.get('state')!;

    const back = await callback(
      'octo',
      `code=directory&state=${state}`,
      baseUrlCookie(response),
      'identity',
      'github-directory-app',
    ).expect(200);
    expect(back.text).toContain('href="https://github.com/apps/speicher-md/installations/new"');

    await postForm('/-/config/identity/octo', { ...formBody(back.text), intent: 'apply' }).expect(
      303,
    );
    const octo = (await stored()).doc.auth.providers.octo;
    // The sign-in App stays as it was
    expect(octo.client_id).toBe('Iv1.abc');
    expect(octo.directory).toMatchObject({ type: 'github', app_id: '4242' });
    expect(octo.directory.private_key).toBe(PEM.trim());
  });

  it('fills a new provider with the directory App, beside a sign-in App entered manually', async () => {
    const response = await startFlow(
      'octo',
      await openNewSource('octo', 'identity'),
      'identity',
      'github-directory-app',
    ).expect(200);
    const state = manifestPostUrl(response.text).searchParams.get('state')!;

    const back = await callback(
      'octo',
      `code=directory&state=${state}`,
      baseUrlCookie(response),
      'identity',
      'github-directory-app',
    ).expect(200);
    expect((await stored()).doc.auth.providers.octo).toBeUndefined();

    await postForm('/-/config/identity/octo?kind=github', {
      ...formBody(back.text),
      'choice:auth.providers.octo.app': 'manual',
      'auth.providers.octo.client_id': 'Iv1.manual',
      'auth.providers.octo.client_secret': 'typed',
      intent: 'apply',
    }).expect(303);
    const octo = (await stored()).doc.auth.providers.octo;
    expect(octo.client_id).toBe('Iv1.manual');
    expect(octo.directory).toMatchObject({ type: 'github', app_id: '4242' });
  });

  it("refuses the state of the provider's sign-in App", async () => {
    await storeProvider('octo');
    const { state, cookie } = await started('fresh', {}, 'identity');
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
