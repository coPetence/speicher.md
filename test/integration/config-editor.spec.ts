import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import request from 'supertest';

import { runCli } from '../../src/cli/cli';
import { brandImageExists } from '../../src/config/brand-store';
import { ConfigService } from '../../src/config/config.service';
import {
  CONFIG_SOURCE_ENV,
  INSTANCE_CONFIG_PATH_ENV,
  appendConfigVersion,
  getNewestConfigVersion,
  loadActiveInstanceConfig,
} from '../../src/config/loader';
import { PALETTE_KEYS } from '../../src/config/palette';
import { loadInstanceConfig, loadInstanceConfigFromFile } from '../../src/config/parser';
import { DEFAULT_TEMPLATE } from '../../src/content-reader/assets.controller';
import { SECTION_EMPTY_ART, emptyStateArt } from '../../src/content-reader/empty-state';
import { templatePalette } from '../../src/content-reader/template-palette';
import { REDACTED } from '../../src/dashboard/configurator/config-form/redact';
import type { FormSection } from '../../src/dashboard/configurator/config-form/fields';
import {
  CONFIG_NAV_SECTIONS,
  CONFIG_SECTIONS,
  GROUP_ID_HELP,
  allFields,
} from '../../src/dashboard/configurator/config-form/fields';
import { renderHelp } from '../../src/global-ui/help-markup';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { FormBody, formBody, formNames } from '../helpers/form';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let harness: Harness;
let dbConfig: ConfigService;
let dbApp: INestApplication;
let fileApp: INestApplication;
let app: INestApplication;
let ops: string;

const ORIGINAL_SOURCE = process.env[CONFIG_SOURCE_ENV];
const CONFIG_PATH = process.env[INSTANCE_CONFIG_PATH_ENV] as string;
const FIXTURE_YAML = readFileSync(CONFIG_PATH, 'utf8');

beforeAll(async () => {
  harness = await createHarness();
  ops = await sessionCookieFor(harness.tenantId, 'ops');

  process.env[CONFIG_SOURCE_ENV] = 'database';
  await resetVersions();
  dbConfig = new ConfigService(await loadActiveInstanceConfig());
  dbApp = await bootTestApp(dbConfig);
  fileApp = await bootTestApp(new ConfigService(loadInstanceConfigFromFile(CONFIG_PATH)));
});

beforeEach(async () => {
  process.env[CONFIG_SOURCE_ENV] = 'database';
  app = dbApp;
  await resetVersions();
  ops = await sessionCookieFor(harness.tenantId, 'ops');
});

afterAll(async () => {
  await dbApp?.close();
  await fileApp?.close();
  if (ORIGINAL_SOURCE === undefined) delete process.env[CONFIG_SOURCE_ENV];
  else process.env[CONFIG_SOURCE_ENV] = ORIGINAL_SOURCE;
  await harness?.close();
  await closeSequelize();
});

async function resetVersions(): Promise<void> {
  await getSequelize().query(`DELETE FROM instance_configs`, { type: QueryTypes.DELETE });
  const seeded = await loadActiveInstanceConfig();
  if (dbConfig) dbConfig.adopt(seeded);
}

async function versionCount(): Promise<number> {
  const rows = await getSequelize().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM instance_configs WHERE tenant_id = :tenantId`,
    { type: QueryTypes.SELECT, replacements: { tenantId: harness.tenantId } },
  );
  return Number(rows[0].count);
}

function useFileMode(): void {
  process.env[CONFIG_SOURCE_ENV] = 'file';
  app = fileApp;
}

async function open(section: string): Promise<{ html: string; body: FormBody }> {
  const page = await request(app.getHttpServer())
    .get(`/-/config/${section}`)
    .set('cookie', ops)
    .expect(200);
  return { html: page.text, body: formBody(page.text) };
}

/** The same answer the page is, as JSON: the section the form was built from */
async function sectionPayload(section: string): Promise<{ section: FormSection }> {
  const page = await request(app.getHttpServer())
    .get(`/-/config/${section}`)
    .set('cookie', ops)
    .set('accept', 'application/json')
    .expect(200);
  return page.body as { section: FormSection };
}

/*
  A section's own title and heading, read from the one list that decides them.
  Retyped, a rename leaves the assertion green on a page that says something else
  -- `Identity` became `Identity Providers` and three of these passed for days.
*/
const titleOf = (id: string): string => {
  const section = CONFIG_SECTIONS.find((entry) => entry.id === id);
  if (!section) throw new Error(`no config section ${id}`);
  return section.title;
};

/** The `<h1>` a page draws, whatever its title says */
const titledHeading = (title: string) =>
  new RegExp(
    `<h1 class="spr-titled">[\\s\\S]*?${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</h1>`,
  );

/** The note an info marker opens, by the id `aria-describedby` points at */
const noteAt = (html: string, id: string, help: string): boolean =>
  html.includes(`id="${id}">${renderHelp(help)}`);

const post = (section: string, body: Record<string, unknown>) =>
  request(app.getHttpServer()).post(`/-/config/${section}`).set('cookie', ops).send(body);

async function landing(section: string, response: request.Response) {
  expect(response.headers.location).toMatch(new RegExp(`^/-/config/${section}\\?saved=\\d+$`));
  return request(app.getHttpServer())
    .get(response.headers.location as string)
    .set('cookie', ops)
    .expect(200);
}

async function addEntry(section: string, name: string, kind = ''): Promise<string> {
  const response = await request(app.getHttpServer())
    .get(`/-/config/${section}`)
    .query({ add: name, kind })
    .set('cookie', ops)
    .expect(303);
  return response.headers.location as string;
}

function kindRows(html: string): Record<string, string> {
  const rows = [
    ...html.matchAll(/<label class="spr-dd-row">[\s\S]*?value="([a-z-]+)"[\s\S]*?<\/label>/g),
  ];
  return Object.fromEntries(rows.map((match) => [match[1], match[0]]));
}

function helpNotes(html: string): string[] {
  return [...html.matchAll(/<p class="spr-(?:help|note)[^"]*">([\s\S]*?)<\/p>/g)].map(
    (match) => match[1],
  );
}

function providerBlock(yaml: string, id: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line.trim() === `${id}:`);
  if (start < 0) return '';
  const indent = lines[start].length - lines[start].trimStart().length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(
    (line) => line.trim() !== '' && line.length - line.trimStart().length <= indent,
  );
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

function withoutSources(yaml: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'forges:');
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim() !== '' && !/^\s/.test(line));
  return [...lines.slice(0, start), ...rest.slice(end)].join('\n');
}

const overview = () => request(app.getHttpServer()).get('/-/config').set('cookie', ops);

async function storeLiteralSecret(): Promise<void> {
  await appendConfigVersion(harness.tenantId, {
    yaml: FIXTURE_YAML.replace(
      'client_secret: ${TEST_ENTRA_CLIENT_SECRET}',
      'client_secret: a-real-secret-value',
    ),
    resolutionHash: 'x',
    origin: 'admin',
    appliedBy: null,
  });
}

async function storeLogo(): Promise<void> {
  await appendConfigVersion(harness.tenantId, {
    yaml:
      `${FIXTURE_YAML}\nbrand:\n  logo: data:image/png;base64,` +
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==\n',
    resolutionHash: 'x',
    origin: 'admin',
    appliedBy: null,
  });
}

async function storeLiteralMailPassword(): Promise<void> {
  await appendConfigVersion(harness.tenantId, {
    yaml: `${FIXTURE_YAML}\nmail:\n  host: smtp.example.test\n  from: Docs <docs@example.test>\n  password: a-real-mail-password\n`,
    resolutionHash: 'x',
    origin: 'admin',
    appliedBy: null,
  });
}

describe('who can reach it', () => {
  it('404s for a maintainer and for an anonymous caller, never 403', async () => {
    const alice = await sessionCookieFor(harness.tenantId, 'alice');
    await request(app.getHttpServer()).get('/-/config').set('cookie', alice).expect(404);
    await request(app.getHttpServer()).get('/-/config').expect(404);
    await request(app.getHttpServer()).get('/-/config/identity').set('cookie', alice).expect(404);
    await request(app.getHttpServer()).get('/-/config/identity').expect(404);
    await request(app.getHttpServer())
      .post('/-/config/identity')
      .set('cookie', alice)
      .send({ intent: 'apply' })
      .expect(404);
    expect(await versionCount()).toBe(1);
  });

  it('404s a section the form does not build, rather than rendering an empty one', async () => {
    await request(app.getHttpServer()).get('/-/config/nonsense').set('cookie', ops).expect(404);
    await request(app.getHttpServer()).get('/-/config/history').set('cookie', ops).expect(200);
  });
});

describe('the overview', () => {
  it('links to every section, and carries no controls of its own', async () => {
    const page = await overview().expect(200);
    for (const section of [
      'identity',
      'groups',
      'admins',
      'sources',
      'reading',
      'defaults',
      'mail',
      'storage',
    ]) {
      expect(page.text).toContain(`href="/-/config/${section}"`);
    }
    // Disabled for now, so not linked
    for (const section of ['analytics', 'notifications', 'embedding']) {
      expect(page.text).not.toContain(`href="/-/config/${section}"`);
    }
    expect(page.text).not.toContain('<form class="spr-config"');
    expect(page.text).not.toContain('Resolution hash');
    expect(page.text).not.toContain(harness.config.resolutionHash);

    for (const child of ['branding/logos', 'branding/appearance']) {
      expect(page.text).not.toContain(`href="/-/config/${child}"`);
    }
  });

  it('draws each section, and each page about the instance, as a card', async () => {
    const html = (await overview().expect(200)).text;
    const cards = [
      ...html.matchAll(/<section class="spr-tile spr-tile-page">([\s\S]*?)<\/section>/g),
    ].map((m) => m[1]);
    const hrefOf = (card: string) => /<h4><a href="([^"]+)">/.exec(card)?.[1];
    expect(cards.map(hrefOf)).toEqual([
      '/-/config/history',
      '/-/config/environment',
      '/-/config/backup',
      ...CONFIG_NAV_SECTIONS.map((section) => `/-/config/${section.id}`),
    ]);

    for (const card of cards) expect(card).toContain('<svg class="spr-icon"');

    const identity = cards.find((card) => hrefOf(card) === '/-/config/identity') ?? '';
    expect(identity).toContain('<p class="spr-card-sub">');
    expect(identity).toContain('href="https://docs.speicher.md/access/identity"');
  });

  it('roots a section page at the overview and ends it in the page itself', async () => {
    const page = await request(app.getHttpServer())
      .get('/-/config/branding')
      .set('cookie', ops)
      .expect(200);
    expect(page.text).toMatch(/<h1 class="spr-titled">[\s\S]*?Branding<\/h1>/);
    expect(page.text).toMatch(
      /<div class="spr-crumbs">\s*<a href="\/-\/config">Configuration<\/a> \/ Branding\s*<\/div>/,
    );
  });

  it('puts the sections under Configuration in the left column', async () => {
    const page = await request(app.getHttpServer())
      .get('/-/config/identity')
      .set('cookie', ops)
      .expect(200);
    expect(page.text).toContain('spr-nav-branch');
    expect(page.text).toMatch(/href="\/-\/config\/identity" aria-current="page"/);

    const elsewhere = await request(app.getHttpServer())
      .get('/-/status')
      .set('cookie', ops)
      .expect(200);
    // Elsewhere the sections are folded shut under Configuration, not open
    expect(elsewhere.text).toMatch(
      /<details class="spr-nav-fold" data-spr-fold="config">\s*<summary[^>]*>\s*<a href="\/-\/config"/,
    );
    expect(elsewhere.text).not.toMatch(/href="\/-\/config\/identity" aria-current/);

    // Unless the reader left it open: the server draws what the column's cookie
    // names, so the branch is open at first paint instead of opened by the island
    const remembered = await request(app.getHttpServer())
      .get('/-/status')
      .set('cookie', `${ops}; speicher_dashboard_open=config`)
      .expect(200);
    expect(remembered.text).toMatch(
      /<details class="spr-nav-fold" data-spr-fold="config" open>\s*<summary[^>]*>\s*<a href="\/-\/config"/,
    );
  });
});

describe('the form', () => {
  it('starts with a disabled submit button, so Enter in a field cannot save', async () => {
    for (const section of ['identity/entra', 'groups', 'branding']) {
      const { html } = await open(section);
      const form = html.slice(html.indexOf('<form class="spr-config"'));
      const firstButton = /<button\b[^>]*>/.exec(form)?.[0] ?? '';

      expect(firstButton).toContain('type="submit"');
      expect(firstButton).toContain('disabled');
    }
  });

  it('renders a control for every setting, named after its place in the document', async () => {
    const named = async (section: string) => Object.keys((await open(section)).body);

    expect(await named('identity/entra')).toEqual(
      expect.arrayContaining([
        'auth.providers.entra.issuer',
        'auth.providers.entra.subject_claim',
        'auth.default_provider',
      ]),
    );
    expect(await named('groups')).toEqual(['__shape:groups']);
    expect(await named('groups/engineering')).toEqual(
      expect.arrayContaining(['groups.engineering.0.provider', 'groups.engineering.0.id']),
    );
    expect(await named('groups/platform-ops')).toEqual(expect.arrayContaining(['admins.groups']));
    expect(await named('admins')).toEqual(['__shape:admins.users']);
    expect(await named('sources')).toEqual(['__shape:forges']);
    expect(await named('sources/gh')).toContain('forges.gh.default_repository_owner');
    expect(await named('branding')).toContain('theme.template');
    expect(await named('reading')).toContain('graph.enabled');
    expect(await named('mail')).toContain('mail.host');
    expect(await named('mail')).not.toContain('notify.stale_after');
    expect(await named('storage')).toContain('assets.driver');
    expect(await named('defaults')).toContain('defaults.sync.include');
  });

  // Notifications and Semantic retrieval are disabled for now
  it.skip('renders a control for every setting on the disabled sections', async () => {
    const named = async (section: string) => Object.keys((await open(section)).body);

    expect(await named('notifications')).toContain('notify.stale_after');
    expect(await named('notifications')).toContain('notify.expiry_warning');
    expect(await named('notifications')).not.toContain('mail.host');
    expect((await open('notifications')).html).toContain('name="notify.sync_failure"');
    expect(await named('embedding')).toContain('embedding.model');
  });

  it('offers no way to change a provider’s kind, which is not a setting', async () => {
    const names = Object.keys((await open('identity/entra')).body);
    expect(names).not.toContain('auth.providers.entra.type');
    await post('identity/entra', {
      ...(await open('identity/entra')).body,
      'auth.providers.entra.type': 'github',
      intent: 'apply',
    }).expect(303);
    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toMatch(
      /entra:\s*\n\s+type: oidc/,
    );
  });

  it("renders a section's controls and no other section's", async () => {
    const identity = Object.keys((await open('identity/entra')).body);
    expect(identity).toContain('auth.providers.entra.issuer');
    expect(identity).not.toContain('theme.template');
    expect(identity).not.toContain('admins.groups');
  });

  it('shows current values, not blanks', async () => {
    const identity = (await open('identity/entra')).body;
    expect(identity['auth.providers.entra.issuer']).toBe('https://login.example.test/v2.0');
    expect(identity['auth.providers.entra.subject_claim']).toBe('oid');

    expect((await open('groups/engineering')).body['groups.engineering.0.id']).toBe('grp-eng');
    expect((await open('groups/platform-ops')).body['admins.groups']).toBe('on');
    expect((await open('groups/engineering')).body['admins.groups']).toBeUndefined();

    expect((await open('sources/gh')).body['forges.gh.default_repository_owner']).toBe('copetence');
  });

  it('renders an environment reference but never a resolved secret', async () => {
    const identity = await open('identity/entra');
    expect(identity.body['auth.providers.entra.client_secret']).toBe('${TEST_ENTRA_CLIENT_SECRET}');
    expect(identity.html).not.toContain(process.env.TEST_ENTRA_CLIENT_SECRET as string);

    const sources = await open('sources');
    expect(sources.html).not.toContain(process.env.TEST_GH_PRIVATE_KEY as string);
    expect((await overview().expect(200)).text).not.toContain(
      process.env.TEST_GH_PRIVATE_KEY as string,
    );
  });
});

describe('downloading the configuration', () => {
  const download = () => request(app.getHttpServer()).get('/-/config/download').set('cookie', ops);
  const backupPage = () => request(app.getHttpServer()).get('/-/config/backup').set('cookie', ops);

  it('is served as a file the browser saves, not a page it renders', async () => {
    const res = await download().expect(200);
    expect(res.headers['content-type']).toContain('application/yaml');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="speicher.instance.yaml"',
    );
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.text).toContain('version: 1');
  });

  it('is named after the instance, never after the request', async () => {
    const before = process.env.SPEICHER_PUBLIC_URL;
    process.env.SPEICHER_PUBLIC_URL = 'https://docs.example.test/';
    try {
      const res = await download().set('host', 'attacker.test').expect(200);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="docs.example.test.instance.yaml"',
      );
      const json = await request(app.getHttpServer())
        .get('/-/config')
        .set('cookie', ops)
        .set('accept', 'application/json')
        .expect(200);
      expect(json.body.backup_filename).toBe('docs.example.test.instance.yaml');
    } finally {
      if (before === undefined) delete process.env.SPEICHER_PUBLIC_URL;
      else process.env.SPEICHER_PUBLIC_URL = before;
    }
  });

  it('references a stored literal by name rather than dropping it', async () => {
    await storeLiteralSecret();
    const res = await download().expect(200);
    expect(res.text).not.toContain('a-real-secret-value');
    expect(res.text).not.toContain(REDACTED);
    expect(res.text).toContain('client_secret: ${AUTH_PROVIDERS_ENTRA_CLIENT_SECRET}');
    expect(res.text).toContain('${TEST_GH_PRIVATE_KEY}');
    expect((await backupPage().expect(200)).text).toContain('AUTH_PROVIDERS_ENTRA_CLIENT_SECRET');
    expect((await overview().expect(200)).text).not.toContain('AUTH_PROVIDERS_ENTRA_CLIENT_SECRET');
    const json = await backupPage().set('accept', 'application/json').expect(200);
    expect(json.body.variables).toEqual(['AUTH_PROVIDERS_ENTRA_CLIENT_SECRET']);
    expect(json.body.yaml).toBe(res.text);
  });

  it('carries the logo, which the page elides for length rather than secrecy', async () => {
    await storeLogo();
    expect((await download().expect(200)).text).toContain('data:image/png;base64');
  });

  it('is offered by its own page, which the overview opens instead of the file', async () => {
    const html = (await overview().expect(200)).text;
    expect(html).toContain('href="/-/config/backup"');
    expect(html).not.toContain('href="/-/config/download"');
    expect(html).toContain('speicher.instance.yaml');
    expect(html).not.toContain('<details class="spr-yaml">');

    const page = (await backupPage().expect(200)).text;
    expect(page).toContain('href="/-/config/download"');
    expect(page).toContain('speicher.instance.yaml');
    expect(page).toContain('<svg class="spr-link-mark"');
    expect(page).toContain('href="https://docs.speicher.md/operate/configuration"');
    expect(page).not.toContain('[documentation](');
    expect(page).not.toContain('<details class="spr-yaml">');
  });

  it("is the reader's 404 for anybody who is not an administrator", async () => {
    await request(app.getHttpServer()).get('/-/config/download').expect(404);
    await request(app.getHttpServer()).get('/-/config/backup').expect(404);
    const alice = await sessionCookieFor(harness.tenantId, 'alice');
    await request(app.getHttpServer()).get('/-/config/backup').set('cookie', alice).expect(404);
  });

  describe('and from the binary', () => {
    let out: string;
    let stdout: jest.SpyInstance;
    let stderr: jest.SpyInstance;

    beforeEach(() => {
      out = '';
      stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out += String(chunk);
        return true;
      });
      stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      stdout.mockRestore();
      stderr.mockRestore();
    });

    it('writes the same document the browser downloads', async () => {
      await storeLiteralSecret();
      expect(await runCli(['config', 'export'])).toBe(0);

      const served = (await download().expect(200)).text;
      expect(out.trimEnd()).toBe(served.trimEnd());
      expect(out).toContain('${AUTH_PROVIDERS_ENTRA_CLIENT_SECRET}');
      expect(out).not.toContain('a-real-secret-value');
    });

    it('writes the credentials in only when asked, and never over HTTP', async () => {
      await storeLiteralSecret();
      expect(await runCli(['config', 'export', '--with-secrets'])).toBe(0);
      expect(out).toContain('client_secret: a-real-secret-value');
      expect((await download().expect(200)).text).not.toContain('a-real-secret-value');
    });
  });
});

describe('the branding section', () => {
  it('puts every explanation behind an info marker, and no paragraph under a control', async () => {
    const { html } = await open('branding');

    const form = html.slice(html.indexOf('<form class="spr-config"'));
    expect(form).toContain('class="spr-info-mark"');
    expect(form).toContain('aria-describedby="help-theme-template"');
    expect(form).toContain('aria-describedby="help-brand-name-align"');
    expect((form.match(/class="spr-info-mark"/g) ?? []).length).toBe(4);
    expect([...form.matchAll(/<p class="spr-help">/g)]).toHaveLength(0);
  });

  it('puts the gallery in a block of its own, after the paired controls', async () => {
    const { html } = await open('branding');

    const wide = html.indexOf('class="spr-fields spr-fields-wide"');
    expect(wide).toBeGreaterThan(-1);
    const paired = html.indexOf('class="spr-fields"');
    expect(paired).toBeGreaterThan(-1);
    expect(paired).toBeLessThan(wide);

    expect(html.slice(wide)).toContain('spr-field-template');
    const first = html.slice(paired, wide);
    expect(first).toContain('name="brand.name"');
    expect(first).toContain('name="attribution"');
    expect(first).not.toContain('spr-field-template');
  });

  it('nests the name switch inside the name field, not beside it', async () => {
    const { html } = await open('branding');
    const box =
      /<div\s+class="spr-field spr-field-text"\s*>([\s\S]*?)<\/div>\s*<div\s+class="spr-field spr-field-boolean"/.exec(
        html,
      )?.[1];
    expect(box).toBeDefined();
    expect(box).toContain('name="brand.name"');
    expect(box).toContain('name="brand.show_name"');
  });

  it('still saves the nested switch, which is the half that could fail silently', async () => {
    const { body } = await open('branding');
    expect(body['brand.show_name']).toBe('on');

    const without = { ...body };
    delete without['brand.show_name'];
    await post('branding', { ...without, intent: 'apply' }).expect(303);

    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toMatch(/show_name: false/);
  });

  it('never puts the marker inside a label', async () => {
    const { html } = await open('branding');
    for (const [, inner] of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
      expect(inner).not.toContain('spr-info');
    }
  });

  it('describes each marker to something that is actually on the page', async () => {
    const { html } = await open('branding');
    const described = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1]);
    expect(described.length).toBeGreaterThan(0);
    for (const id of described) expect(html).toContain(`id="${id}"`);
  });

  it('asks on every other section too, rather than printing on some of them', async () => {
    // Notifications and Read analytics are left out while they are disabled
    for (const section of ['reading', 'storage', 'defaults']) {
      const { html } = await open(section);
      const form = html.slice(html.indexOf('<form class="spr-config"'));
      expect(form).toContain('class="spr-info-mark"');
      expect([...form.matchAll(/<p class="spr-help">/g)]).toHaveLength(0);
    }
  });
});

describe('the palette', () => {
  async function paint(colour = '#8a4b2f'): Promise<void> {
    const { body } = await open('branding/appearance');
    await post('branding/appearance', {
      ...body,
      'theme.palette.light.accent': colour,
      intent: 'apply',
    }).expect(303);
    dbConfig.adopt(await loadActiveInstanceConfig());
  }

  it('offers both schemes and writes only the one that was answered', async () => {
    const { html, body } = await open('branding/appearance');

    expect(html).toMatch(/>\s*Light\s*</);
    expect(html).toMatch(/>\s*Dark\s*</);
    const names = Object.keys(body);
    for (const scheme of ['light', 'dark']) {
      for (const key of PALETTE_KEYS) {
        expect(names).toContain(`theme.palette.${scheme}.${key}`);
      }
    }
    for (const head of ['Highlights', 'Callouts', 'Code']) {
      expect(html).toMatch(new RegExp(`>\\s*${head}\\s*<`));
    }

    await paint();

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toMatch(/light:\s+accent: ["']#8a4b2f["']/);
    expect(yaml).not.toMatch(/\bdark:/);
  });

  it('takes a colour back out when its box is emptied', async () => {
    await paint();

    const { body } = await open('branding/appearance');
    expect(body['theme.palette.light.accent']).toBe('#8a4b2f');

    await post('branding/appearance', {
      ...body,
      'theme.palette.light.accent': '',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).not.toContain('#8a4b2f');
    expect(yaml).not.toMatch(/palette:/);
  });

  it('saves a colour whose key carries a hyphen, which is most of them', async () => {
    const { body } = await open('branding/appearance');
    await post('branding/appearance', {
      ...body,
      'theme.palette.dark.code-keyword': '#ff9a90',
      intent: 'apply',
    }).expect(303);
    dbConfig.adopt(await loadActiveInstanceConfig());

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toMatch(/dark:\s+code-keyword: ["']#ff9a90["']/);

    const page = await request(app.getHttpServer()).get('/').set('cookie', ops).expect(200);
    expect(page.text).toContain('--spr-code-keyword:#ff9a90');
    expect(page.text).toContain('@media (prefers-color-scheme: dark)');
    expect(page.text).not.toContain('prefers-color-scheme: light');
    expect(page.text).not.toContain('color-mix');
  });

  it('refuses a colour that is not one, with the loader\u2019s own message', async () => {
    const { body } = await open('branding/appearance');
    const refused = await post('branding/appearance', {
      ...body,
      'theme.palette.light.bg': 'cornflowerblue',
      intent: 'apply',
    }).expect(400);

    expect(refused.text).toContain('theme.palette.light.bg');
    expect(refused.text).toContain('cornflowerblue');
  });

  it('shows the template\u2019s own colour in an empty box, without submitting it', async () => {
    const { html, body } = await open('branding/appearance');
    const light = templatePalette(DEFAULT_TEMPLATE, 'light');
    const dark = templatePalette(DEFAULT_TEMPLATE, 'dark');

    expect(html).toContain(`placeholder="${light.accent}"`);
    expect(light.accent).not.toBe(dark.accent);
    expect(html).toContain(`placeholder="${dark.accent}"`);

    expect(body['theme.palette.light.accent']).toBe('');
    await post('branding/appearance', { ...body, intent: 'apply' }).expect(303);
    expect((await getNewestConfigVersion(harness.tenantId))?.yaml ?? '').not.toMatch(/palette:/);
  });

  it('keeps showing it after a colour is taken back out', async () => {
    const { body } = await open('branding/appearance');
    await post('branding/appearance', {
      ...body,
      'theme.palette.light.accent': '#123456',
      intent: 'apply',
    }).expect(303);

    const painted = await open('branding/appearance');
    expect(painted.body['theme.palette.light.accent']).toBe('#123456');

    await post('branding/appearance', {
      ...painted.body,
      'theme.palette.light.accent': '',
      intent: 'apply',
    }).expect(303);

    const { html, body: cleared } = await open('branding/appearance');
    expect(cleared['theme.palette.light.accent']).toBe('');
    expect(html).toContain(`placeholder="${templatePalette(DEFAULT_TEMPLATE, 'light').accent}"`);
  });

  describe('the reset', () => {
    const RESET = 'reset:branding/appearance';

    async function dress(): Promise<void> {
      const { body } = await open('branding/appearance');
      await post('branding/appearance', {
        ...body,
        'theme.font': 'serif',
        'theme.palette.light.accent': '#8a4b2f',
        intent: 'apply',
      }).expect(303);
    }

    async function reset(): Promise<{ html: string; body: FormBody }> {
      const { body } = await open('branding/appearance');
      const round = await post('branding/appearance', { ...body, op: RESET }).expect(200);
      return { html: round.text, body: formBody(round.text) };
    }

    it('is offered only where there is something to take back out', async () => {
      expect((await open('branding/appearance')).html).not.toContain(RESET);

      await dress();
      expect((await open('branding/appearance')).html).toContain(`value="${RESET}"`);
    });

    it('stores nothing on its own, and empties every box it offers', async () => {
      await dress();
      const before = await versionCount();

      const round = await reset();

      expect(await versionCount()).toBe(before);
      expect(round.html).toContain('data-spr-pending');
      expect(round.body['theme.palette.light.accent']).toBe('');
      expect(round.body['theme.font']).toBe('');
    });

    it('takes both keys out of the document, and leaves the template alone', async () => {
      const branding = await open('branding');
      await post('branding', {
        ...branding.body,
        'theme.template': 'editorial',
        intent: 'apply',
      }).expect(303);
      await dress();

      const round = await reset();
      await post('branding/appearance', { ...round.body, intent: 'apply' }).expect(303);

      const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
      expect(yaml).not.toMatch(/\bfont:/);
      expect(yaml).not.toMatch(/palette:/);
      expect(yaml).toMatch(/template: editorial/);
    });

    it('reaches nothing from a page that did not offer it', async () => {
      await dress();
      const { body } = await open('reading');
      await post('reading', { ...body, op: RESET, intent: 'apply' }).expect(303);

      const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
      expect(yaml).toMatch(/font: serif/);
      expect(yaml).toMatch(/accent: /);
    });
  });

  it('carries the instance\u2019s own palette into every template preview', async () => {
    await paint();

    const preview = await request(app.getHttpServer())
      .get('/-/config/preview/default')
      .set('cookie', ops)
      .expect(200);

    expect(preview.text).toContain('--spr-accent:#8a4b2f');
    expect(preview.text).toContain('@media (prefers-color-scheme: light)');
    expect(preview.text).not.toContain('--spr-nav-user');
  });

  it('paints the documentation and never the page that sets it', async () => {
    await paint();

    const settings = await request(app.getHttpServer())
      .get('/-/config/branding/appearance')
      .set('cookie', ops)
      .expect(200);
    expect(settings.text).not.toContain('--spr-accent');

    const page = await request(app.getHttpServer()).get('/').set('cookie', ops).expect(200);
    expect(page.text).toContain('--spr-accent:#8a4b2f');
  });

  it('is reached from Branding as a page, not as a control on it', async () => {
    const { html, body } = await open('branding');
    expect(html).toContain('href="/-/config/branding/appearance"');
    expect(Object.keys(body).filter((name) => name.startsWith('theme.palette'))).toEqual([]);
  });
});

describe('the identity section', () => {
  it('lists each provider as a tile that opens it, and renders no field of theirs', async () => {
    const { html } = await open('identity');
    const form = html.slice(html.indexOf('<form class="spr-config"'));

    expect(form).toContain('class="spr-tile"');
    expect(form).toContain('href="/-/config/identity/entra"');
    expect(form).toContain('OpenID Connect');
    expect(form).toContain('>Default</span>');

    expect(Object.keys(formBody(html))).toEqual(['__shape:auth.providers']);
  });

  it('offers Add outside the form, so a save cannot carry it', async () => {
    const { html } = await open('identity');
    expect(html).toMatch(/<form id="add-member" method="get" action="\/-\/config\/identity">/);
    expect(html).toMatch(/name="add"\s+form="add-member"/);
    expect(Object.keys(formBody(html))).not.toContain('add');
  });

  it('offers the kinds in the modal and not on the index', async () => {
    const { html } = await open('identity');
    expect(html).not.toContain('data-spr-kind=');
    expect(html).not.toContain('spr-kinds-head');
    expect(html).toMatch(/<section class="spr-tile spr-tile-add">\s*<details class="spr-modal">/);
    expect(html).not.toMatch(/<details class="spr-modal" open>/);
  });

  it('suggests a free id for each kind, so the box is right before it is touched', async () => {
    const page = await open('identity');
    expect(page.html).toMatch(/value="entra"[^>]*\s+data-spr-suggest="entra-2"/);
    expect(page.html).toMatch(/value="github"[^>]*\s+data-spr-suggest="github"/);
    expect(page.html).toContain('data-spr-suggests="add-name"');

    // GitHub is the first kind, so the box starts with its suggestion
    const box = /<input\s+id="add-name"[^>]*value="([^"]*)"/.exec(page.html)?.[1];
    expect(box).toBe('github');
    expect(page.html.indexOf('name="kind"')).toBeLessThan(page.html.indexOf('id="add-name"'));
    expect(page.html).toMatch(/value="github"[^>]*checked/);
  });

  it('names each kind by its logo, in a dropdown that can carry one', async () => {
    const page = await open('identity');
    expect(page.html).not.toMatch(/<select[^>]*name="kind"/);
    expect(page.html).toContain('<details class="spr-dropdown">');

    const kinds = kindRows(page.html);
    expect(Object.keys(kinds).sort()).toEqual(['entra', 'github', 'magic-link', 'oidc']);
    expect(kinds.entra).toContain('<svg class="spr-icon" width="16" height="16"');
    expect(kinds.entra).not.toContain('<use');
    expect(kinds.entra).toMatch(/<svg[\s\S]*<\/svg><span>Microsoft Entra ID<\/span>/);
    expect(kinds.github).toMatch(/<svg[\s\S]*<\/svg><span>GitHub<\/span>/);
    expect(kinds['magic-link']).toContain('stroke="currentColor"');
    expect(kinds.entra).toContain('form="add-member"');
    expect(kinds.entra).toMatch(/class="spr-clipped"\s+type="radio"/);
  });

  it('marks the magic link while the instance has no transport, and keeps it pickable', async () => {
    const page = await open('identity');
    const row = kindRows(page.html)['magic-link'];
    expect(row).toContain('data-spr-unavailable');
    expect(row).not.toContain('disabled');
    expect(row).not.toContain('checked');
    expect(page.html).toMatch(/value="github"[^>]*checked/);

    const said = helpNotes(page.html).find((text) => text.includes('mail transport'));
    expect(said).toBeDefined();
    expect(page.html).toContain('class="spr-note spr-note-warn spr-choice-note"');
    expect(said).toContain('<a href="/-/config/mail">');
    expect(page.html.indexOf(said!)).toBeGreaterThan(page.html.indexOf('spr-modal-panel'));

    expect(page.html).toMatch(/<button\s+type="submit"\s+form="add-member"\s*>[^<]*<\/button>/);
  });

  it('marks nothing once the transport is configured', async () => {
    const mail = await open('mail');
    await post('mail', {
      ...mail.body,
      'mail.host': 'smtp.example.test',
      'mail.from': 'Docs <docs@example.test>',
      intent: 'apply',
    }).expect(303);

    const page = await open('identity');
    expect(kindRows(page.html)['magic-link']).not.toContain('data-spr-unavailable');
    expect(helpNotes(page.html).filter((text) => text.includes('mail transport'))).toEqual([]);
  });

  it('asks for no short id on the page the wizard lands on, and saves under the suggested one', async () => {
    const draft = await open('identity/oidc?kind=oidc');
    expect(draft.html).not.toContain('newname:identity/oidc');
    expect(draft.html).not.toContain('f-member-id');

    const applied = await post('identity/oidc?kind=oidc', {
      ...draft.body,
      'auth.providers.oidc.issuer': 'https://id.example.test',
      'auth.providers.oidc.client_id': 'corp-client',
      intent: 'apply',
    }).expect(303);
    expect(applied.headers.location).toMatch(/^\/-\/config\/identity\/oidc\?saved=/);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(providerBlock(yaml, 'oidc')).toContain('https://id.example.test');

    // Once saved, the pencil renames it
    expect((await open('identity/oidc')).html).toContain('value="rename:auth.providers.oidc"');
  });

  it("explains a group's short id in the add popup", async () => {
    const index = await open('groups');
    expect(index.html).toMatch(/<label for="add-name">\s*Short id\s*<\/label>/);
    expect(index.html).not.toContain('Internal name');
    expect(noteAt(index.html, 'help-add-name', GROUP_ID_HELP)).toBe(true);
  });

  it('creates the provider the Add tile was filled in for', async () => {
    expect(await addEntry('identity', 'entra-2', 'entra')).toBe(
      '/-/config/identity/entra-2?kind=entra',
    );
    const draft = await open('identity/entra-2?kind=entra');
    await post('identity/entra-2?kind=entra', {
      ...draft.body,
      'auth.providers.entra-2.issuer': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'auth.providers.entra-2.client_id': 'ms-client',
      'auth.providers.entra-2.client_secret': 'ms-secret',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('entra-2:');
    expect((await open('identity')).html).toMatch(
      /value="entra"[^>]*\s+data-spr-suggest="entra-3"/,
    );
  });

  it('draws the whole directory block on a provider that has none', async () => {
    expect(FIXTURE_YAML).not.toContain('directory:');
    const { html, body } = await open('identity/entra');
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining([
        'auth.providers.entra.directory.type',
        'auth.providers.entra.directory.tenant_id',
        'auth.providers.entra.directory.client_id',
        'auth.providers.entra.directory.client_secret',
        'auth.providers.entra.directory.cache_ttl',
        'auth.providers.entra.connection_idle_ttl',
      ]),
    );
    expect(
      (html.match(/data-spr-shown-with="auth\.providers\.entra\.directory\.type"/g) ?? []).length,
    ).toBe(5);

    for (const key of ['client_id', 'client_secret']) {
      expect(html).toContain(`data-spr-copy-from="auth.providers.entra.${key}"`);
      expect(html).toMatch(
        new RegExp(
          `<button\\s+type="button"\\s+data-spr-copy="auth\\.providers\\.entra\\.directory\\.${key}"\\s+hidden\\s*>`,
        ),
      );
    }
    expect(html).not.toContain('data-spr-copy="auth.providers.entra.directory.tenant_id"');
  });

  it('draws no connection check where there is no directory to connect to', async () => {
    const { html } = await open('identity/entra');
    expect(html).not.toContain('spr-note-fail');
    expect(html).not.toContain('spr-note-ok');
  });

  it('configures a directory lookup from one save, and unconfigures it from one more', async () => {
    const { body } = await open('identity/entra');
    await post('identity/entra', {
      ...body,
      'auth.providers.entra.directory.type': 'graph',
      'auth.providers.entra.directory.tenant_id': 'a-tenant-guid',
      'auth.providers.entra.directory.client_id': 'graph-client',
      'auth.providers.entra.directory.client_secret': '${TEST_ENTRA_CLIENT_SECRET}',
      intent: 'apply',
    }).expect(303);

    const stored = providerBlock(
      (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '',
      'entra',
    );
    expect(stored).toContain('directory:');
    expect(stored).toContain('tenant_id: a-tenant-guid');
    expect(stored).toContain('client_id: graph-client');

    const again = await open('identity/entra');
    expect(again.body['auth.providers.entra.directory.client_id']).toBe('graph-client');
    const off = await post('identity/entra', {
      ...again.body,
      'auth.providers.entra.directory.type': '',
      intent: 'apply',
    }).expect(303);
    await landing('identity/entra', off);

    expect(
      providerBlock((await getNewestConfigVersion(harness.tenantId))?.yaml ?? '', 'entra'),
    ).not.toContain('directory');
  });

  it('puts every explanation on a provider’s page behind an info marker', async () => {
    const { html } = await open('identity/entra');
    const form = html.slice(html.indexOf('<form class="spr-config"'));
    const payload = await sectionPayload('identity/entra');

    /*
      The markers are matched against the field model the form was built from,
      because the claim is "every explanation, and none of them as a paragraph".
      A literal count said that only until somebody added a control, and then
      said nothing at all (it read 11 on a page drawing 12 for a week); a set
      also names the explanation that went missing. The Short id's marker is not
      in here: that control sits above this form, and its own test owns it.
    */
    const explained = allFields([payload.section])
      .filter((field) => field.help)
      .map((field) => `help-${field.path.replace(/[._]/g, '-')}`);
    const drawn = [...form.matchAll(/aria-describedby="(help-[^"]+)"/g)].map((m) => m[1]);

    expect(form).toContain('name="auth.providers.entra.issuer"');
    expect([...form.matchAll(/<p class="spr-help">/g)]).toHaveLength(0);
    expect(drawn.sort()).toEqual(explained.sort());
  });

  it('keeps the hidden-secret warning on screen, which is where it can happen', async () => {
    await storeLiteralSecret();
    const { html } = await open('identity/entra');
    expect(html).toContain('spr-help-warn');
    expect(html).toContain('Configured. Type to replace it; blank keeps it.');
    expect(html).toMatch(/aria-describedby="help-auth-providers-entra-client-secret"/);
  });

  it('opens a section under the symbol the nav drew beside it', async () => {
    const { html } = await open('identity');
    expect(html).toMatch(
      new RegExp(
        `<h1 class="spr-titled"><svg class="spr-icon"[\\s\\S]*?${titleOf('identity')}</h1>`,
      ),
    );
    expect(html).not.toMatch(/<h1 class="spr-titled">\s*<svg[^>]*><use/);
    const member = await open('identity/entra');
    expect(member.html).toMatch(
      /<h1 class="spr-titled"><svg class="spr-icon" aria-hidden="true"><use href="#m-[a-z]+">[\s\S]*?entra<\/h1>/,
    );
  });

  it('says where it is, in the breadcrumb under /-/config', async () => {
    const { html } = await open('identity/entra');
    expect(html).toMatch(/<h1 class="spr-titled">[\s\S]*entra<\/h1>/);
    expect(html).toMatch(
      new RegExp(
        `<div class="spr-crumbs">\\s*<a href="/-/config">Configuration</a> / ` +
          `<a href="/-/config/identity">${titleOf('identity')}</a> / entra\\s*</div>`,
      ),
    );
    expect(html).toMatch(/href="\/-\/config\/identity" aria-current="true"/);
  });

  it('names every page above a source, not only the one it came from', async () => {
    const { html } = await open('groups/engineering/entra');
    expect(html).toMatch(
      /<div class="spr-crumbs">\s*<a href="\/-\/config">Configuration<\/a> \/ <a href="\/-\/config\/groups">Groups<\/a> \/ <a href="\/-\/config\/groups\/engineering">engineering<\/a> \/ entra\s*<\/div>/,
    );
    const crumbs = html.slice(html.indexOf('<div class="spr-crumbs">'));
    expect(crumbs.slice(0, crumbs.indexOf('</div>'))).not.toContain('<svg');
    expect(html).not.toContain('arrow-left');
  });

  it('never puts the marker inside a label', async () => {
    const { html } = await open('identity/entra');
    for (const [, inner] of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
      expect(inner).not.toContain('spr-info');
    }
  });

  it('describes each marker to something that is actually on the page', async () => {
    const { html } = await open('identity/entra');
    const described = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1]);
    expect(described.length).toBeGreaterThan(0);
    expect(new Set(described).size).toBe(described.length);
    for (const id of described) expect(html).toContain(`id="${id}"`);
  });
});

describe('every way to remove something', () => {
  it('hands the island what it needs to grow a table, rather than a scheme', async () => {
    const { html } = await open('groups/engineering/entra');

    expect(html).toMatch(/data-spr-grow="groups\.engineering"[^>]*data-spr-kind="group"/);
    expect(html).toMatch(/data-spr-grow="groups\.engineering"[^>]*data-spr-kind="person"/);

    expect(html).toContain('<tr data-spr-position="0">');
    expect(html).toContain('<tr data-spr-position="1" data-spr-trailing>');
    expect(html).toContain('<tr data-spr-position="2" data-spr-trailing>');
  });

  it('keeps a column’s info marker out of any scroll container', async () => {
    const { html } = await open('groups/engineering/entra');
    expect(html).toContain('class="spr-info"');
    for (const [, inside] of html.matchAll(/<div class="spr-scroll">([\s\S]*?)<\/div>/g)) {
      expect(inside).not.toContain('spr-info');
    }
    expect(html).toMatch(/<th scope="col">Expire by\s*<span class="spr-info">/);
  });

  it('selects rows with a box in front of them, and removes them together', async () => {
    const page = await open('groups/engineering/entra');
    await post('groups/engineering/entra', {
      ...page.body,
      'groups.engineering.2.email': 'alice@example.test',
      'groups.engineering.2.note': 'contractor',
      intent: 'apply',
    }).expect(303);

    const { html, body } = await open('groups/engineering/entra');
    expect(html).toMatch(
      /<input type="checkbox" name="select" value="remove:groups\.engineering\.0"/,
    );
    expect(html).toMatch(
      /<input type="checkbox" name="select" value="remove:groups\.engineering\.1"/,
    );
    expect(html).not.toMatch(/name="select" value="remove:groups\.engineering\.2"/);

    const removed = await post('groups/engineering/entra', {
      ...body,
      select: ['remove:groups.engineering.1'],
      op: 'remove-selected:groups.engineering',
    }).expect(200);
    expect(removed.text).not.toContain('alice@example.test');
    expect(removed.text).toContain('grp-eng');

    await post('groups/engineering/entra', {
      ...formBody(removed.text),
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).not.toContain('alice@example.test');
    expect(yaml).toContain('grp-eng');
  });

  it('removes the lower row correctly when several are selected at once', async () => {
    const first = await open('groups/engineering/entra');
    await post('groups/engineering/entra', {
      ...first.body,
      'groups.engineering.1.id': 'grp-two',
      'groups.engineering.2.email': 'alice@example.test',
      'groups.engineering.2.note': 'contractor',
      intent: 'apply',
    }).expect(303);
    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toContain('grp-two');

    const { body } = await open('groups/engineering/entra');
    const removed = await post('groups/engineering/entra', {
      ...body,
      select: ['remove:groups.engineering.0', 'remove:groups.engineering.2'],
      op: 'remove-selected:groups.engineering',
    }).expect(200);
    await post('groups/engineering/entra', {
      ...formBody(removed.text),
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('grp-two');
    expect(yaml).not.toContain("grp-eng'");
    expect(yaml).not.toContain('alice@example.test');
  });

  it('ignores a selected row the page never offered', async () => {
    const { body } = await open('groups/engineering/entra');
    const answered = await post('groups/engineering/entra', {
      ...body,
      select: ['remove:groups.commercial.0'],
      op: 'remove-selected:groups.engineering',
    }).expect(200);
    expect(answered.text).toContain('grp-eng');

    await post('groups/engineering/entra', {
      ...formBody(answered.text),
      intent: 'apply',
    }).expect(303);
    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toContain('grp-com');
  });

  it('draws a bin in front of the word, wherever a removal is offered', async () => {
    const pages = [await open('groups/engineering'), await open('sources/gh')];

    for (const page of pages) {
      const buttons = [
        ...page.html.matchAll(/<button[^>]*class="spr-remove"[^>]*>([\s\S]*?)<\/button>/g),
      ];
      expect(buttons.length).toBeGreaterThan(0);
      for (const [, inner] of buttons) {
        expect(inner).toMatch(/^<svg class="spr-icon"[\s\S]*<\/svg>Remove/);
        expect(inner).not.toContain('<use');
      }
    }
  });
});

describe('the content sources section', () => {
  it('picks a kind from the same dropdown the identity index uses', async () => {
    const page = await open('sources');
    expect(page.html).not.toMatch(/<select[^>]*name="kind"/);
    expect(page.html).toContain('<details class="spr-dropdown">');
    expect(page.html).not.toContain('data-spr-kind=');

    const kinds = kindRows(page.html);
    expect(Object.keys(kinds).sort()).toEqual(['forgejo', 'git', 'gitea', 'github', 'gitlab']);
    for (const kind of Object.values(kinds)) {
      expect(kind).toContain('<svg class="spr-icon" width="16" height="16"');
    }
    expect(kinds.gitlab).toContain('#E24329');
    expect(kinds.git).toContain('#DE4C36');
  });

  it("offers the App's webhook URL to copy on the source it belongs to", async () => {
    const before = process.env.SPEICHER_PUBLIC_URL;
    process.env.SPEICHER_PUBLIC_URL = 'https://docs.acme.example/';
    try {
      const { html } = await open('sources/gh');
      expect(html).toMatch(
        /<span\s+class="spr-copyable"\s*>\s*<code>https:\/\/docs\.acme\.example\/-\/hooks\/forge\/gh<\/code>[\s\S]*?<p class="spr-help">\s*Enter this as the <strong>Webhook URL<\/strong> in the settings of your GitHub App\./,
      );
      expect(html).toContain('data-spr-clipboard="https://docs.acme.example/-/hooks/forge/gh"');
      expect(html).toContain('data-spr-copy-status');
      expect(html).not.toContain('data-spr-origin-path');
    } finally {
      if (before === undefined) delete process.env.SPEICHER_PUBLIC_URL;
      else process.env.SPEICHER_PUBLIC_URL = before;
    }
  });

  it('offers the webhook path to copy when the public URL is unset, with a sentence that works without JavaScript', async () => {
    const before = process.env.SPEICHER_PUBLIC_URL;
    delete process.env.SPEICHER_PUBLIC_URL;
    try {
      const { html } = await open('sources/gh');
      expect(html).toMatch(/class="spr-copyable"\s*data-spr-origin-path/);
      expect(html).toContain('data-spr-clipboard="/-/hooks/forge/gh"');
      // One sentence that also reads right while only the path is shown
      expect(html).toContain(
        'If only a path without a host is shown, put the address of this instance in front of it.',
      );
    } finally {
      if (before !== undefined) process.env.SPEICHER_PUBLIC_URL = before;
    }
  });

  it('removes the last source, and the instance still loads without one', async () => {
    const member = await open('sources/gh');
    expect(member.html).toContain('name="op" value="remove:forges.gh"');
    expect(member.html).toContain('formaction="/-/config/sources"');

    const { html } = await open('sources');
    const removed = await post('sources', {
      '__shape:forges': String(formBody(html)['__shape:forges']),
      op: 'remove:forges.gh',
    }).expect(200);
    expect(removed.text).not.toContain('data-spr-row="gh"');
    expect(removed.text).toContain('No sources here yet.');
    expect(/data-spr-empty="none"\s*([^>]*)>/.exec(removed.text)?.[1]).not.toContain('hidden');
    expect(removed.text).toMatch(
      /<div class="spr-empty-state" data-spr-empty="none"[^>]*>\s*<svg class="spr-empty-art"/,
    );
    expect(removed.text).toMatch(/<div class="spr-scroll" hidden>/);
    expect(removed.text).toMatch(/name="add"\s+form="add-member"/);

    await landing(
      'sources',
      await post('sources', { ...formBody(removed.text), intent: 'apply' }).expect(303),
    );

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).not.toMatch(/^\s+gh:$/m);
    expect(loadInstanceConfig(yaml).primaryForgeId).toBeNull();
  });

  it('boots with no source at all, and answers a reader rather than failing', async () => {
    const config = new ConfigService(loadInstanceConfig(withoutSources(FIXTURE_YAML)));
    expect(config.primaryForgeId).toBeNull();

    const empty = await bootTestApp(config);
    try {
      const status = await request(empty.getHttpServer())
        .get('/-/status')
        .set('cookie', ops)
        .expect(200);
      expect(status.text).not.toContain('/-/discover');

      const alice = await sessionCookieFor(harness.tenantId, 'alice');
      await request(empty.getHttpServer()).get('/handbook/').set('cookie', alice).expect(404);
      await request(app.getHttpServer()).get('/handbook/').set('cookie', alice).expect(200);
    } finally {
      await empty.close();
    }
  });

  it('marks a row with the same logo the kind was picked by', async () => {
    const page = await open('sources');
    const row = /<tr data-spr-row="gh[\s\S]*?<\/tr>/.exec(page.html)?.[0] ?? '';
    expect(row).toContain('#m-github');
  });
});

describe('the groups section', () => {
  it('lists every group as a row, with what it is mapped to, and no field', async () => {
    const { html } = await open('groups');
    const form = html.slice(html.indexOf('<form class="spr-config"'));

    expect(form).toContain('class="spr-table spr-entries"');
    expect(form).toContain('href="/-/config/groups/engineering"');
    expect(form).toContain('entra (grp-eng)');
    expect(form).toContain('entra (grp-northwind)');
    expect(form).toMatch(
      /platform-ops[\s\S]*?spr-badge-icon[\s\S]*?<span class="spr-clipped">Administrators<\/span>/,
    );
    expect(form).not.toContain('#i-shield');

    expect(Object.keys(formBody(html))).toEqual(['__shape:groups']);
  });

  it('renders no administrator control, which is why they are two pages', async () => {
    const { html } = await open('groups');
    expect(Object.keys(formBody(html))).not.toContain('admins.groups');

    const removed = await post('groups', {
      '__shape:groups': String(formBody(html)['__shape:groups']),
      op: 'remove:groups.client-northwind',
    }).expect(200);
    await post('groups', { ...formBody(removed.text), intent: 'apply' }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).not.toContain('client-northwind');
    expect(yaml).toMatch(/groups: \[\s*platform-ops\s*\]/);
  });

  it('puts the filter and Add in one bar, as two forms that submit apart', async () => {
    const { html } = await open('groups');
    const bar = html.slice(html.indexOf('spr-index-bar'), html.indexOf('<form class="spr-config"'));

    expect(bar).toContain('<form class="spr-form spr-filter" method="get"');
    expect(bar).toContain('class="spr-modal spr-index-add"');
    expect(bar).toMatch(/name="add"\s+form="add-member"/);
    expect(bar).not.toContain('name="kind"');
    expect(bar).not.toMatch(/<option\s+value="entra"/);

    expect(html).toContain('<form id="add-member" method="get" action="/-/config/groups">');
    expect(Object.keys(formBody(html))).not.toContain('add');
  });

  it('elides a long provider group id in the cell and never in the filter', async () => {
    const guid = '383eb267-19ec-4adb-972b-c881ed56e4cd';
    const { body } = await open('groups/engineering');
    await post('groups/engineering', {
      ...body,
      'groups.engineering.0.id': guid,
      intent: 'apply',
    }).expect(303);

    const { html } = await open('groups');
    expect(html).toContain('<code>entra (383eb267…)</code>');
    expect(html).not.toContain(`<code>entra (${guid})</code>`);
    expect(html).toContain(`data-spr-row="engineering entra (${guid})"`);

    const filtered = await request(app.getHttpServer())
      .get('/-/config/groups')
      .query({ q: guid })
      .set('cookie', ops)
      .expect(200);
    expect(filtered.text).toContain('href="/-/config/groups/engineering"');
    expect(filtered.text).not.toContain('href="/-/config/groups/commercial"');

    expect((await open('groups/engineering')).body['groups.engineering.0.id']).toBe(guid);
  });

  it('says when each group was added and by whom, from the version history', async () => {
    const seeded = await open('groups');
    expect(seeded.html).toContain('<th scope="col">Added by</th>');
    expect(seeded.html).toMatch(/engineering<\/a>[\s\S]*?spr-cell-quiet">seeded</);

    await addEntry('groups', 'client-acme');
    const draft = await open('groups/client-acme');
    await post('groups/client-acme', { ...draft.body, intent: 'apply' }).expect(303);

    const after = await open('groups');
    expect(after.html).toMatch(/client-acme<\/a>[\s\S]*?spr-cell-quiet">ops@copetence\.test</);
    expect(after.html).toMatch(/engineering<\/a>[\s\S]*?spr-cell-quiet">seeded</);
  });

  it('narrows the table on the server, so the box works with no script', async () => {
    const page = await request(app.getHttpServer())
      .get('/-/config/groups')
      .query({ q: 'northwind' })
      .set('cookie', ops)
      .expect(200);

    expect(page.text).toContain('href="/-/config/groups/client-northwind"');
    expect(page.text).not.toContain('href="/-/config/groups/engineering"');
    expect(page.text).toMatch(/<input id="filter-groups"[^>]*value="northwind"/);
    expect(page.text).toContain('<form class="spr-form spr-filter" method="get"');
  });

  it('matches what a row shows, not a key behind it', async () => {
    const page = await request(app.getHttpServer())
      .get('/-/config/groups')
      .query({ q: 'grp-ops' })
      .set('cookie', ops)
      .expect(200);
    expect(page.text).toContain('href="/-/config/groups/platform-ops"');
    expect(page.text).not.toContain('href="/-/config/groups/engineering"');
  });

  it('gives each index the drawing that is its own', async () => {
    for (const id of SECTION_EMPTY_ART) {
      const { html } = await open(id);
      expect(html).toContain(emptyStateArt(id));
    }
    expect((await open('sources/gh')).html).not.toContain('spr-empty-art');
  });

  it('says a query matched nothing differently from having nothing', async () => {
    const page = await request(app.getHttpServer())
      .get('/-/config/groups')
      .query({ q: 'nothing-matches-this' })
      .set('cookie', ops)
      .expect(200);

    const notes = (attr: string) =>
      new RegExp(`data-spr-empty="${attr}"\\s*([^>]*)>`).exec(page.text)?.[1] ?? '';
    expect(notes('filtered')).not.toContain('hidden');
    expect(page.text).toContain('<code data-spr-needle>nothing-matches-this</code>');
    expect(page.text).toContain('href="/-/config/groups">Show all</a>');
    expect(page.text).toMatch(
      /<div class="spr-empty-state" data-spr-empty="filtered"[^>]*>\s*<svg class="spr-empty-art"/,
    );
    expect(page.text).toContain(emptyStateArt('groups'));
    expect(page.text).not.toMatch(/class="spr-note[^"]*" data-spr-empty=/);
    expect(page.text).toMatch(/<div class="spr-scroll" hidden>/);
    expect(notes('none')).toContain('hidden');
    expect(page.text).toContain('No groups here yet.');

    const all = await open('groups');
    const unfiltered = (attr: string) =>
      new RegExp(`data-spr-empty="${attr}"\\s*([^>]*)>`).exec(all.html)?.[1] ?? '';
    expect(unfiltered('none')).toContain('hidden');
    expect(unfiltered('filtered')).toContain('hidden');
    expect(all.html).toContain('<div class="spr-scroll">');
    expect(all.html).toContain('class="spr-empty-art"');
  });

  it('filters what is drawn and never what is saved', async () => {
    const page = await request(app.getHttpServer())
      .get('/-/config/groups')
      .query({ q: 'northwind' })
      .set('cookie', ops)
      .expect(200);

    const body = formBody(page.text);
    expect(String(body['__shape:groups']).split(',').sort()).toEqual([
      'client-northwind',
      'commercial',
      'engineering',
      'platform-ops',
    ]);
    await post('groups', { ...body, intent: 'apply' }).expect(303);
    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    for (const name of ['engineering', 'commercial', 'client-northwind', 'platform-ops']) {
      expect(yaml).toContain(`${name}:`);
    }
  });

  it('carries the whole page of one group, and nothing about another', async () => {
    const { html, body } = await open('groups/engineering');
    expect(html).toMatch(/<h1>engineering<\/h1>/);
    expect(Object.keys(body)).toContain('groups.engineering.0.id');
    expect(Object.keys(body)).not.toContain('groups.commercial.0.id');
    expect(Object.keys(body)).toContain('__shape:groups.engineering');
    expect(Object.keys(body)).not.toContain('__shape:groups');

    expect(html).toMatch(
      /<div class="spr-crumbs">\s*<a href="\/-\/config">Configuration<\/a> \/ <a href="\/-\/config\/groups">Groups<\/a> \/ engineering\s*<\/div>/,
    );
    expect(html).toMatch(/href="\/-\/config\/groups" aria-current="true"/);

    expect(html).toMatch(
      /formaction="\/-\/config\/groups">(<svg[\s\S]*?<\/svg>)?Remove this group<\/button>/,
    );
    expect(html).toContain('href="/-/config/groups/engineering/entra"');
    expect(html).toContain('class="spr-modal spr-index-add"');
    expect(html).toMatch(/<details class="spr-dropdown">[\s\S]*?name="add"\s+value="entra"/);
    expect(html).toMatch(/<label class="spr-dd-row">[\s\S]*?<svg[\s\S]*?<span>entra<\/span>/);
  });

  it('creates a group from its own first save, with nothing mapped to it yet', async () => {
    const href = await addEntry('groups', 'client-acme');
    expect(href).toBe('/-/config/groups/client-acme');

    const draft = await open('groups/client-acme');
    expect(draft.html).toContain('data-spr-pending');
    expect(draft.html).toContain('No sources here yet.');
    expect(await versionCount()).toBe(1);

    await post('groups/client-acme', { ...draft.body, intent: 'apply' }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(loadInstanceConfig(yaml).raw.groups!['client-acme']).toEqual([]);
    expect(yaml).toContain('grp-eng');
  });

  it('takes the first source from the group’s own page, once there is one to name', async () => {
    await addEntry('groups', 'client-acme');
    const draft = await open('groups/client-acme');
    await post('groups/client-acme', { ...draft.body, intent: 'apply' }).expect(303);

    expect(await addEntry('groups/client-acme', 'entra')).toBe(
      '/-/config/groups/client-acme/entra',
    );
    const source = await open('groups/client-acme/entra');
    await post('groups/client-acme/entra', {
      ...source.body,
      'groups.client-acme.0.id': 'grp-acme',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(loadInstanceConfig(yaml).raw.groups!['client-acme']).toEqual([
      { provider: 'entra', id: 'grp-acme' },
    ]);
  });

  it('grants administrator access from the group’s own page, and off by default', async () => {
    const fresh = await open('groups/engineering');
    expect(Object.keys(fresh.body)).not.toContain('admins.groups');
    expect(fresh.html).toContain('name="admins.groups"');

    await post('groups/engineering', {
      ...fresh.body,
      'admins.groups': 'on',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toMatch(/groups: \[\s*platform-ops,\s*engineering\s*\]/);

    const index = await open('groups');
    expect(index.html).toMatch(/engineering<\/a>[\s\S]*?spr-clipped">Administrators/);
  });

  it('takes only this group out of the admin list, never the others', async () => {
    const withBoth = await open('groups/engineering');
    await post('groups/engineering', {
      ...withBoth.body,
      'admins.groups': 'on',
      intent: 'apply',
    }).expect(303);

    const on = await open('groups/engineering');
    expect(on.body['admins.groups']).toBe('on');
    await post('groups/engineering', {
      ...on.body,
      'admins.groups': undefined,
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toMatch(/admins:\n\s+groups: \[\s*platform-ops\s*\]/);
  });

  it('renames a group and every reference to it in this document', async () => {
    const { body } = await open('groups/platform-ops');
    const response = await post('groups/platform-ops', {
      ...body,
      op: 'rename:groups.platform-ops',
      rename: 'operations',
    });
    expect(response.status).toBe(303);
    expect(response.headers.location).toMatch(/^\/-\/config\/groups\/operations\?saved=\d+$/);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('operations:');
    expect(yaml).not.toContain('platform-ops');
    expect(yaml).toMatch(/groups: \[\s*operations\s*\]/);
  });

  it('refuses a rename onto a name another group has, rather than merging them', async () => {
    const { body } = await open('groups/engineering');
    const refused = await post('groups/engineering', {
      ...body,
      op: 'rename:groups.engineering',
      rename: 'commercial',
    }).expect(400);
    expect(refused.text).toContain('There is already a group called &quot;commercial&quot;');
    expect(await versionCount()).toBe(1);
  });

  it('says a repository’s own grant is not ours to rewrite, in the right word', async () => {
    const { html } = await open('groups/engineering');
    expect(html.replace(/\s+/g, ' ')).toContain('break group references');
  });

  it('lists the repositories a rename would reach, from the materialised rows', async () => {
    const { html } = await open('groups/engineering');
    const modal = html.slice(html.indexOf('spr-modal-panel'), html.indexOf('spr-modal-actions'));

    expect(modal).toContain('copetence/handbook');
    expect(modal).toMatch(/\d+\s*page/);
    expect(modal).not.toContain('onboarding');
  });

  it('draws the level of each note the rename modal asks with, and not only its tint', async () => {
    const warned = await open('groups/engineering');
    expect(warned.html).toMatch(
      /<p class="spr-note spr-note-warn"><svg class="spr-icon"[^>]*><use href="#i-triangle-alert"\/>/,
    );

    const quiet = await open('groups/platform-ops');
    expect(quiet.html).toMatch(
      /<p class="spr-note spr-note-ok"><svg class="spr-icon"[^>]*><use href="#i-circle-check"\/>/,
    );
  });

  it('marks the warning notes on the rename modal, and the reassuring one', async () => {
    const warned = await open('groups/engineering');
    const warnModal = warned.html.slice(
      warned.html.indexOf('spr-modal-panel'),
      warned.html.indexOf('spr-modal-actions'),
    );
    expect(warnModal).toMatch(
      /<p class="spr-note spr-note-warn"><svg.*?<\/svg>Renaming will enqueue/,
    );

    const quiet = await open('groups/platform-ops');
    expect(quiet.html).toMatch(
      /<p class="spr-note spr-note-ok"><svg.*?<\/svg>No <code>\.speicher\.yaml<\/code>/,
    );
  });

  it('says outright when a name reaches nothing, rather than showing an empty list', async () => {
    const { html } = await open('groups/platform-ops');
    expect(html.replace(/\s+/g, ' ')).toContain('references this group');
  });

  it('lists a group’s sources as one row per provider, and carries their values', async () => {
    const { html } = await open('groups/engineering');
    const table = html.slice(html.indexOf('spr-entries'), html.indexOf('</table>'));

    expect(table).toContain('<th scope="col">Provider</th>');
    expect(table).toContain('<th scope="col">Matches</th>');
    expect(table).toContain('href="/-/config/groups/engineering/entra"');
    expect(table).toContain('<code>grp-eng</code>');
    expect(table).toContain(
      '<input type="hidden" name="groups.engineering.0.provider" value="entra">',
    );
    expect(table).toContain('<input type="hidden" name="groups.engineering.0.id" value="grp-eng">');
  });

  it('keeps the right matches when the middle one is removed', async () => {
    const add = async (id: string) => {
      const page = await open('groups/engineering/entra');
      const grown = await post('groups/engineering/entra', {
        ...page.body,
        op: 'add:groups.engineering.provider.entra',
      }).expect(200);
      const at = String(formBody(grown.text)['__shape:groups.engineering']).split(',').length - 1;
      await post('groups/engineering/entra', {
        ...formBody(grown.text),
        [`groups.engineering.${at}.id`]: id,
        intent: 'apply',
      }).expect(303);
    };
    await add('grp-two');
    await add('grp-three');

    const before = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(before).toContain('grp-eng');
    expect(before).toContain('grp-two');
    expect(before).toContain('grp-three');

    const page = await open('groups/engineering/entra');
    const afterRemove = await post('groups/engineering/entra', {
      ...page.body,
      op: 'remove:groups.engineering.1',
    }).expect(200);
    expect(afterRemove.text).not.toContain('grp-two');

    await post('groups/engineering/entra', {
      ...formBody(afterRemove.text),
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('grp-eng');
    expect(yaml).toContain('grp-three');
    expect(yaml).not.toContain('grp-two');
  });

  it('takes every match with it when the source itself is removed', async () => {
    const page = await open('groups/engineering/entra');
    expect(page.html).toMatch(
      /formaction="\/-\/config\/groups\/engineering">(<svg[\s\S]*?<\/svg>)?Remove this source<\/button>/,
    );

    const { body } = await open('groups/engineering');
    const gone = await post('groups/engineering', {
      ...body,
      op: 'remove:groups.engineering.provider.entra',
    }).expect(200);
    expect(gone.text).not.toContain('grp-eng<');
    expect(gone.text).not.toContain('grp-ops');
    expect(await versionCount()).toBe(1);
  });

  it('saves a group whose last source is gone, and keeps the name', async () => {
    const { body } = await open('groups/engineering');
    const gone = await post('groups/engineering', {
      ...body,
      op: 'remove:groups.engineering.provider.entra',
    }).expect(200);
    expect(gone.text).toContain('No sources here yet.');

    await landing(
      'groups/engineering',
      await post('groups/engineering', { ...formBody(gone.text), intent: 'apply' }).expect(303),
    );

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(loadInstanceConfig(yaml).raw.groups!.engineering).toEqual([]);
    const index = await open('groups');
    expect(index.html).toMatch(/engineering<\/a>[\s\S]*?no sources yet/);
  });

  it('refuses to empty the group that is holding the admin surface', async () => {
    const { body } = await open('groups/platform-ops');
    const gone = await post('groups/platform-ops', {
      ...body,
      op: 'remove:groups.platform-ops.provider.entra',
    }).expect(200);

    const refused = await post('groups/platform-ops', {
      ...formBody(gone.text),
      intent: 'apply',
    }).expect(400);
    expect(refused.text).toContain('has no members');
    expect(await versionCount()).toBe(1);

    const checked = await post('groups/platform-ops', {
      ...formBody(gone.text),
      intent: 'check',
    }).expect(400);
    expect(checked.text).toContain('has no members');
    expect(await versionCount()).toBe(1);
  });

  it('creates a source from the provider the Add names', async () => {
    const href = await addEntry('groups/commercial', 'entra');
    expect(href).toBe('/-/config/groups/commercial/entra');

    const page = await open('groups/commercial/entra');
    expect(page.html).toContain('value="grp-com"');

    const grown = await post('groups/commercial/entra', {
      ...page.body,
      op: 'add:groups.commercial.provider.entra',
    }).expect(200);
    expect(await versionCount()).toBe(1);

    const at = String(formBody(grown.text)['__shape:groups.commercial']).split(',').length - 1;
    await post('groups/commercial/entra', {
      ...formBody(grown.text),
      [`groups.commercial.${at}.id`]: 'grp-second',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('grp-second');
    expect(yaml).toMatch(/provider: entra\s*\n\s*id: grp-second/);
    expect(yaml).toContain('grp-com');
    expect(yaml).toContain('grp-eng');
  });

  it('adds a person to a group, and they survive their own save', async () => {
    const page = await open('groups/engineering/entra');
    expect(page.body['groups.engineering.2.email']).toBe('');

    await post('groups/engineering/entra', {
      ...page.body,
      'groups.engineering.2.email': 'alice@example.test',
      'groups.engineering.2.note': 'contractor on the migration',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('alice@example.test');
    expect(yaml).toContain('contractor on the migration');
    expect(yaml).toMatch(/provider: entra\s*\n\s*email: alice@example\.test/);
    expect(yaml).toContain('grp-eng');
    expect(yaml).not.toContain('null');
  });

  it('writes nothing at all when the empty rows are left empty', async () => {
    const before = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    const { body } = await open('groups/engineering/entra');
    await post('groups/engineering/entra', { ...body, intent: 'apply' }).expect(303);

    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toBe(before);
  });

  it('draws two tables from one sequence, split by what each source names', async () => {
    const { html } = await open('groups/engineering/entra');

    expect(html).toContain('<h2 class="spr-table-title">entra groups</h2>');
    expect(html).toContain('<h2 class="spr-table-title">People</h2>');

    const groups = html.slice(html.indexOf('entra groups</h2>'), html.indexOf('People</h2>'));
    const people = html.slice(html.indexOf('People</h2>'));

    expect(groups).toContain('<th scope="col">entra group id');
    expect(groups).toContain('name="groups.engineering.0.id"');

    expect(people).toContain('<th scope="col">Person');
    expect(people).toContain('<th scope="col">Note');
    expect(people).toContain('<th scope="col">Expire by');

    expect(people).toMatch(
      /Expire by\s*<span class="spr-info">[\s\S]*a real expiry rather than a reminder/,
    );

    expect(groups).toContain('name="groups.engineering.1.id"');
    expect(people).toContain('name="groups.engineering.2.email"');
    expect(html).not.toContain('add:groups.engineering');

    expect(groups.match(/value="remove:groups\.engineering\.\d+"/g)).toEqual([
      'value="remove:groups.engineering.0"',
    ]);
  });

  it('offers the subject box to somebody already stored by subject', async () => {
    const page = await open('groups/engineering/entra');
    await post('groups/engineering/entra', {
      ...page.body,
      'groups.engineering.2.email': 'alice@example.test',
      'groups.engineering.2.note': 'n',
      intent: 'apply',
    }).expect(303);

    const stored = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    await appendConfigVersion(harness.tenantId, {
      yaml: stored.replace('email: alice@example.test', 'subject: oid-42'),
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });

    const { html } = await open('groups/engineering/entra');
    expect(html).toMatch(/name="groups\.engineering\.1\.subject"[^>]*value="oid-42"/);
    expect(html).toContain('<input type="hidden" name="groups.engineering.1.email" value="">');
  });

  it('removes a person by position, and keeps the mapping beside them', async () => {
    const page = await open('groups/engineering/entra');
    await post('groups/engineering/entra', {
      ...page.body,
      'groups.engineering.2.email': 'alice@example.test',
      'groups.engineering.2.note': 'n',
      intent: 'apply',
    }).expect(303);

    const withPerson = await open('groups/engineering/entra');
    const removed = await post('groups/engineering/entra', {
      ...withPerson.body,
      op: 'remove:groups.engineering.1',
    }).expect(200);
    expect(removed.text).not.toContain('alice@example.test');

    await post('groups/engineering/entra', {
      ...formBody(removed.text),
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).not.toContain('alice@example.test');
    expect(yaml).toContain('grp-eng');
  });

  it('keeps a reason and a review date written against a mapping', async () => {
    const { body } = await open('groups/engineering/entra');
    await post('groups/engineering/entra', {
      ...body,
      'groups.engineering.0.note': 'the Engineering distribution list',
      'groups.engineering.0.until': '2027-01-01',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('the Engineering distribution list');
    expect(yaml).toContain('2027-01-01');
    expect(yaml).toContain('grp-eng');

    const { html } = await open('groups/engineering/entra');
    const groups = html.slice(html.indexOf('entra groups</h2>'), html.indexOf('People</h2>'));
    expect(groups).toMatch(
      /name="groups\.engineering\.0\.note"[^>]*value="the Engineering distribution list"/,
    );
  });

  it('round-trips a mapping’s reason through a save made from the group index', async () => {
    const source = await open('groups/engineering/entra');
    await post('groups/engineering/entra', {
      ...source.body,
      'groups.engineering.0.note': 'the Engineering distribution list',
      intent: 'apply',
    }).expect(303);

    const index = await open('groups/engineering');
    expect(index.body['groups.engineering.0.note']).toBe('the Engineering distribution list');
    await post('groups/engineering', { ...index.body, intent: 'apply' }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('the Engineering distribution list');
  });

  it('removes the mapping above a person, and keeps the person', async () => {
    const page = await open('groups/engineering/entra');
    await post('groups/engineering/entra', {
      ...page.body,
      'groups.engineering.2.email': 'alice@example.test',
      'groups.engineering.2.note': 'contractor',
      intent: 'apply',
    }).expect(303);
    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toContain('grp-eng');

    const both = await open('groups/engineering/entra');
    const removed = await post('groups/engineering/entra', {
      ...both.body,
      op: 'remove:groups.engineering.0',
    }).expect(200);
    await post('groups/engineering/entra', {
      ...formBody(removed.text),
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('alice@example.test');
    expect(yaml).toContain('contractor');
    expect(yaml).not.toContain('grp-eng');
  });

  it('saves a person with no note, which is optional on every shape', async () => {
    const { body } = await open('groups/engineering/entra');
    await post('groups/engineering/entra', {
      ...body,
      'groups.engineering.2.email': 'alice@example.test',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('alice@example.test');
    expect(yaml).not.toContain('note:');
  });

  it('404s a third segment that names no provider of this instance', async () => {
    await request(app.getHttpServer())
      .get('/-/config/groups/engineering/5')
      .set('cookie', ops)
      .expect(404);
    await request(app.getHttpServer())
      .get('/-/config/groups/engineering/first')
      .set('cookie', ops)
      .expect(404);
    await request(app.getHttpServer())
      .get('/-/config/identity/entra/0')
      .set('cookie', ops)
      .expect(404);
  });

  it('says what a source matched on, not only what it matched', async () => {
    const { html } = await open('groups/engineering');
    expect(html).toMatch(/<span class="spr-line-label">Group<\/span>\s*<code>grp-eng<\/code>/);

    expect(html).toMatch(
      /<svg class="spr-icon" aria-hidden="true"><use href="#m-openid"><\/use><\/svg>\s*<a href="\/-\/config\/groups\/engineering\/entra">entra<\/a>/,
    );
    expect(html).toContain('<symbol id="m-openid"');
  });

  it('marks each source line on the index, where one group may draw from several', async () => {
    const { html } = await open('groups');
    const at = html.indexOf('data-spr-row="engineering');
    const cell = html.slice(at, html.indexOf('</tr>', at));
    expect(cell).toContain('<use href="#m-openid">');
    expect(cell).toContain('<code>entra (grp-eng)</code>');
    expect(html).toContain('<symbol id="m-openid"');
  });

  it('asks a source for the one thing its provider can match on', async () => {
    const { html, body } = await open('groups/engineering/entra');
    expect(html).toContain('<th scope="col">entra group id');
    expect(html).toMatch(/name="groups.engineering.0.id"[^>]*aria-label="Provider group id"/);
    expect(html).toMatch(/name="groups.engineering.0.id"[^>]*placeholder="group identifier"/);
    expect(html).toContain('<input type="hidden" name="groups.engineering.0.domain" value="">');
    expect(html).not.toContain('for="f-groups.engineering.0.domain"');

    const json = await post('groups/engineering/entra', { ...body, intent: 'check' })
      .set('accept', 'application/json')
      .expect(200);
    expect(json.body.verdict.effect).toBe('none');
  });

  it('404s a name no group key could take', async () => {
    await request(app.getHttpServer())
      .get('/-/config/groups/Not%20A%20Group')
      .set('cookie', ops)
      .expect(404);
  });
});

describe('the Entra kind', () => {
  const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;

  async function createEntra(): Promise<void> {
    await addEntry('identity', 'ms', 'entra');
    const draft = await open('identity/ms?kind=entra');
    await post('identity/ms?kind=entra', {
      ...draft.body,
      'auth.providers.ms.issuer': TENANT,
      'auth.providers.ms.client_id': 'ms-client',
      'auth.providers.ms.client_secret': 'ms-secret',
      intent: 'apply',
    }).expect(303);
  }

  it('asks for a directory id and writes the issuer, with the claims Entra emits', async () => {
    await addEntry('identity', 'ms', 'entra');
    const draft = await open('identity/ms?kind=entra');

    expect(draft.html).toContain('Directory (tenant) id');
    expect(draft.html).not.toMatch(/>\s*Issuer URL\s*</);
    expect(draft.body['auth.providers.ms.subject_claim']).toBe('oid');
    expect(draft.body['auth.providers.ms.email_claim']).toBe('preferred_username');

    await post('identity/ms?kind=entra', {
      ...draft.body,
      'auth.providers.ms.issuer': TENANT,
      'auth.providers.ms.client_id': 'ms-client',
      'auth.providers.ms.client_secret': 'ms-secret',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain(`issuer: ${ISSUER}`);
    expect(yaml).toContain('subject_claim: oid');
    expect(yaml).toContain('email_claim: preferred_username');
    expect(yaml).toContain('type: oidc');
    expect(yaml).not.toContain('type: entra');
  });

  it('reads back as Entra, on its page and on its tile', async () => {
    await createEntra();

    const page = await open('identity/ms');
    expect(page.body['auth.providers.ms.issuer']).toBe(TENANT);
    expect(page.html).toContain('Microsoft Entra ID');
    expect(page.html).toContain('#m-microsoft');

    const index = await open('identity');
    expect(index.html).toContain('Microsoft Entra ID');
    expect(index.html).toContain('<symbol id="m-microsoft"');
  });

  it('is a plain OpenID Connect provider when the issuer is not one it composes', async () => {
    const page = await open('identity/entra');
    expect(page.body['auth.providers.entra.issuer']).toBe('https://login.example.test/v2.0');
    expect(page.html).toContain('Issuer URL');
    expect(page.html).not.toContain('Directory (tenant) id');
  });
});

describe('the default switch', () => {
  it('moves the default by ticking it on another provider’s page', async () => {
    await addEntry('identity', 'okta', 'oidc');
    await post('identity/okta?kind=oidc', {
      ...(await open('identity/okta?kind=oidc')).body,
      'auth.providers.okta.issuer': 'https://okta.example.test/oauth2/default',
      'auth.providers.okta.client_id': 'okta-client',
      intent: 'apply',
    }).expect(303);

    const okta = await open('identity/okta');
    expect(okta.body['auth.default_provider']).toBeUndefined();

    await post('identity/okta', {
      ...okta.body,
      'auth.default_provider': 'on',
      intent: 'apply',
    }).expect(303);

    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toMatch(
      /default_provider: okta/,
    );
    const index = await open('identity');
    expect(index.html).toMatch(/okta[\s\S]*?Default<\/span>/);
  });

  it('does not clear a default naming somebody else', async () => {
    await addEntry('identity', 'okta', 'oidc');
    await post('identity/okta?kind=oidc', {
      ...(await open('identity/okta?kind=oidc')).body,
      'auth.providers.okta.issuer': 'https://okta.example.test/oauth2/default',
      'auth.providers.okta.client_id': 'okta-client',
      intent: 'apply',
    }).expect(303);

    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toMatch(
      /default_provider: entra/,
    );
  });
});

describe('editing', () => {
  it('saves an untouched form without changing a single byte', async () => {
    const { body } = await open('branding');
    await post('branding', { ...body, intent: 'apply' }).expect(303);

    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toBe(FIXTURE_YAML);
  });

  it('changes the field that was edited and nothing else', async () => {
    const { body } = await open('branding');
    const posted = await post('branding', {
      ...body,
      'theme.template': 'editorial',
      intent: 'apply',
    }).expect(303);
    const page = await landing('branding', posted);
    expect(page.text).toContain('spr-toast');
    expect(page.text).toContain('Saved.');
    expect(page.text).not.toMatch(/Saved as version/);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('template: editorial');
    expect(yaml).toContain('# Instance config for the test fixture.');
    expect(yaml).toContain("- { provider: entra, id: 'grp-eng' }");
  });

  it('leaves the other sections exactly as they were', async () => {
    const { body } = await open('identity/entra');
    await post('identity/entra', {
      ...body,
      'auth.providers.entra.subject_claim': 'sub',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('subject_claim: sub');
    const before = FIXTURE_YAML.split('\n');
    const after = yaml.split('\n');
    expect(after.length).toBe(before.length);
    for (const line of after.filter((l, i) => l !== before[i])) {
      if (line === '      subject_claim: sub') continue;
      expect(line).toMatch(/\[ .* \]/);
    }
  });

  it('states the verdict before the save, and writes nothing while checking', async () => {
    const { body } = await open('branding');
    const page = await post('branding', {
      ...body,
      'theme.template': 'editorial',
      intent: 'check',
    }).expect(200);

    expect(page.text).toContain('<section class="spr-verdict">');
    expect(page.text).toContain('No restart required');
    expect(formBody(page.text)['theme.template']).toBe('editorial');
    expect(await versionCount()).toBe(1);
  });

  it('says defining a group means a full rebuild, before it happens', async () => {
    const draft = await open('groups/client-acme/entra');
    const page = await post('groups/client-acme/entra', {
      ...draft.body,
      'groups.client-acme.0.id': 'grp-acme',
      intent: 'check',
    }).expect(200);

    expect(page.text).toContain('full rebuild');
  });

  it('says a membership change costs no rebuild', async () => {
    const { body } = await open('groups/engineering/entra');
    const json = await post('groups/engineering/entra', {
      ...body,
      'groups.engineering.0.id': 'grp-engineering-renamed',
      intent: 'check',
    })
      .set('accept', 'application/json')
      .expect(200);

    expect(json.body.verdict.changed.map((c: { key: string }) => c.key)).toContain('groups');
    expect(json.body.verdict.rebuild).toBe(false);
  });

  it('reports nothing to do when nothing was touched', async () => {
    const { body } = await open('branding');
    const json = await post('branding', { ...body, intent: 'check' })
      .set('accept', 'application/json')
      .expect(200);
    expect(json.body.verdict.effect).toBe('none');
  });

  it('empties a value by clearing its control', async () => {
    const { body } = await open('sources/gh');
    await post('sources/gh', {
      ...body,
      'forges.gh.default_repository_owner': '',
      intent: 'apply',
    }).expect(303);
    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).not.toContain(
      'default_repository_owner',
    );
  });

  it('writes nothing for a field the form never offered', async () => {
    const { body } = await open('identity/entra');
    await post('identity/entra', {
      ...body,
      'admins.groups.99': 'attacker-group',
      'auth.providers.backdoor.issuer': 'https://evil.test',
      'theme.template': 'editorial',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).not.toContain('attacker-group');
    expect(yaml).not.toContain('backdoor');
    expect(yaml).not.toContain('template: editorial');
  });
});

describe('a value with a unit', () => {
  it('offers the amount and the unit as two controls of one field', async () => {
    const { html, body } = await open('storage');

    expect(body['assets.max_asset_bytes']).toBe('10');
    expect(body['unit:assets.max_asset_bytes']).toBe('MB');
    expect(html).toContain('class="spr-unit"');
    expect(html).toMatch(/aria-label="Largest asset, unit"/);
  });

  it('writes nothing for a default it only showed', async () => {
    const { body } = await open('storage');
    await post('storage', { ...body, intent: 'apply' }).expect(303);
    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toBe(FIXTURE_YAML);
  });

  it('stores the amount multiplied by the unit', async () => {
    const { body } = await open('storage');
    await post('storage', {
      ...body,
      'assets.path': './var/assets',
      'assets.max_asset_bytes': '2',
      'unit:assets.max_asset_bytes': 'GB',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('max_asset_bytes: 2000000000');
  });

  it('comes back out in the unit it was stored in', async () => {
    const { body } = await open('storage');
    await post('storage', {
      ...body,
      'assets.path': './var/assets',
      'assets.max_asset_bytes': '2',
      'unit:assets.max_asset_bytes': 'GB',
      intent: 'apply',
    }).expect(303);

    const again = await open('storage');
    expect(again.body['assets.max_asset_bytes']).toBe('2');
    expect(again.body['unit:assets.max_asset_bytes']).toBe('GB');
  });
});

describe('picking a different asset driver', () => {
  it('answers with the questions the new driver asks, rather than refusing the save', async () => {
    const { html, body } = await open('storage');
    expect(formNames(html)).not.toContain('assets.account');

    const round = await post('storage', {
      ...body,
      'assets.driver': 'azure',
      intent: 'apply',
    }).expect(200);

    expect(formNames(round.text)).toEqual(
      expect.arrayContaining(['assets.account', 'assets.container', 'assets.auth']),
    );
    expect(round.text).not.toContain('must have required property');
    expect(await versionCount()).toBe(1);
  });

  it('stores it once the new questions are answered', async () => {
    const { body } = await open('storage');
    const round = await post('storage', {
      ...body,
      'assets.driver': 'azure',
      intent: 'apply',
    }).expect(200);

    const saved = await post('storage', {
      ...formBody(round.text),
      'assets.account': 'acmedocs',
      'assets.container': 'assets',
      intent: 'apply',
    }).expect(303);
    await landing('storage', saved);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('driver: azure');
    expect(yaml).toContain('account: acmedocs');
  });

  it('asks the credential question its own answer needs, and only that one', async () => {
    const { body } = await open('storage');
    const azure = await post('storage', {
      ...body,
      'assets.driver': 'azure',
      intent: 'apply',
    }).expect(200);
    expect(formNames(azure.text)).toContain('assets.account_key');
    expect(formNames(azure.text)).not.toContain('assets.client_id');

    const identity = await post('storage', {
      ...formBody(azure.text),
      'assets.auth': 'managed_identity',
      intent: 'apply',
    }).expect(200);
    expect(formNames(identity.text)).toContain('assets.client_id');
    expect(formNames(identity.text)).not.toContain('assets.account_key');
    expect(await versionCount()).toBe(1);
  });

  it('saves a change made beside the control it left alone, in one press', async () => {
    const { body } = await open('storage');
    expect(body['assets.driver']).toBe('filesystem');

    await post('storage', {
      ...body,
      'assets.path': './var/assets',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('path: ./var/assets');
    expect(yaml).toContain('driver: filesystem');
  });

  it('leaves a document with no asset block alone when nothing on the page was touched', async () => {
    const { body } = await open('storage');
    await post('storage', { ...body, intent: 'apply' }).expect(303);
    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toBe(FIXTURE_YAML);
  });
});

describe('the logos page', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const SVG = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
  );

  function pngSized(width: number, height: number): Buffer {
    const resized = Buffer.from(PNG);
    resized.writeUInt32BE(width, 16);
    resized.writeUInt32BE(height, 20);
    return resized;
  }

  const WEBP = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x1a, 0, 0, 0]),
    Buffer.from('WEBPVP8 '),
    Buffer.alloc(10),
  ]);

  const PICKERS = ['brand.logo', 'brand.logo_dark', 'brand.icon'];

  function submitFiles(body: FormBody, files: Record<string, { bytes: Buffer; name: string }>) {
    let req = request(app.getHttpServer()).post('/-/config/branding/logos').set('cookie', ops);
    for (const [name, value] of Object.entries(body)) {
      if (PICKERS.includes(name)) continue;
      for (const one of Array.isArray(value) ? value : [value]) req = req.field(name, one);
    }
    for (const [name, file] of Object.entries(files)) req = req.attach(name, file.bytes, file.name);
    return req;
  }

  function submit(body: FormBody, file: { bytes: Buffer; name: string } | null) {
    let req = request(app.getHttpServer()).post('/-/config/branding/logos').set('cookie', ops);
    for (const [name, value] of Object.entries(body)) {
      if (name === 'brand.logo') continue;
      for (const one of Array.isArray(value) ? value : [value]) req = req.field(name, one);
    }
    if (file) req = req.attach('brand.logo', file.bytes, file.name);
    return req;
  }

  it('takes an uploaded file into the document, and serves it from this instance', async () => {
    const { body } = await open('branding/logos');
    const posted = await submit(
      { ...body, intent: 'apply' },
      {
        bytes: PNG,
        name: 'logo.png',
      },
    ).expect(303);
    const page = await landing('branding/logos', posted);
    expect(page.text).toContain('spr-toast');

    // The document names the image; the bytes are a row of their own, so a save
    // of any other key from here on copies a reference and not a picture.
    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    const hash = /logo: sha256:([0-9a-f]{64})/.exec(yaml)?.[1] as string;
    expect(hash).toEqual(expect.any(String));
    expect(yaml).not.toContain('data:image/png');
    expect(await brandImageExists(harness.tenantId, hash)).toBe(true);

    const src = /<img[^>]*src="(\/-\/brand\/[^"]+)"/.exec(page.text)?.[1] as string;
    expect(src).toBe(`/-/brand/${hash}.png`);

    const served = await request(app.getHttpServer()).get(src).expect(200);
    expect(Buffer.from(served.body).equals(PNG)).toBe(true);
    expect(served.headers['content-type']).toContain('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['cache-control']).toContain('immutable');
  });

  it('serves it to a caller who is not signed in', async () => {
    const { body } = await open('branding/logos');
    const posted = await submit(
      { ...body, intent: 'apply' },
      {
        bytes: SVG,
        name: 'logo.svg',
      },
    ).expect(303);
    const page = await landing('branding/logos', posted);
    const src = /<img[^>]*src="(\/-\/brand\/[^"]+)"/.exec(page.text)?.[1] as string;

    const served = await request(app.getHttpServer()).get(src).expect(200);
    expect(served.headers['content-type']).toContain('image/svg+xml');
    expect(served.headers['content-security-policy']).toContain("default-src 'none'");
    expect(served.headers['content-security-policy']).toContain('sandbox');
  });

  it("404s any name that is not the running configuration's logo", async () => {
    await request(app.getHttpServer()).get('/-/brand/0000000000000000.png').expect(404);
    await request(app.getHttpServer()).get('/-/brand/..%2f..%2fpackage.json').expect(404);
  });

  it('keeps the stored logo when the picker is left alone', async () => {
    const first = await open('branding/logos');
    await submit({ ...first.body, intent: 'apply' }, { bytes: PNG, name: 'logo.png' }).expect(303);

    const second = await open('branding/logos');
    await submit({ ...second.body, intent: 'apply' }, null).expect(303);
    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toMatch(
      /logo: sha256:[0-9a-f]{64}/,
    );
  });

  it('shows what is stored, with the picture the instance is actually serving', async () => {
    const first = await open('branding/logos');
    await submit({ ...first.body, intent: 'apply' }, { bytes: PNG, name: 'logo.png' }).expect(303);

    const { html } = await open('branding/logos');
    const form = html.slice(html.indexOf('<form class="spr-config"'));
    expect(form).toContain('class="spr-stored"');
    expect(form).toContain('PNG, 70 bytes');
    expect(form).toMatch(
      /class="spr-stored-pick"\s+for="f-brand\.logo"[\s\S]*?class="spr-file spr-file-tucked"\s+id="f-brand\.logo"\s+name="brand\.logo"[\s\S]*?name="remove:brand\.logo"/,
    );
    /*
      The same image, reached two ways: the header through the public route,
      which serves what the running configuration resolved to, and the
      thumbnail through the admin one, which serves anything stored — including
      a picture that has been picked and not yet saved.
    */
    const header = /<img[^>]*src="\/-\/brand\/([0-9a-f]{64})\.png"/.exec(html)?.[1] as string;
    expect(form).toContain(`src="/-/config/brand/${header}"`);
    const thumb = await request(app.getHttpServer())
      .get(`/-/config/brand/${header}`)
      .set('cookie', ops)
      .expect(200);
    expect(Buffer.from(thumb.body).equals(PNG)).toBe(true);
    expect(thumb.headers['cache-control']).toContain('no-store');
  });

  it('leaves the picker whole while there is nothing stored to describe', async () => {
    const { html } = await open('branding/logos');
    const form = html.slice(html.indexOf('<form class="spr-config"'));
    expect(form).toMatch(/class="spr-file"\s+id="f-brand\.logo"/);
    expect(form).not.toContain('spr-file-tucked');
    expect(form).not.toContain('class="spr-stored"');
    expect(form).not.toContain('name="remove:brand.logo"');
  });

  it('says what is stored without drawing it when the two are not the same bytes', async () => {
    const first = await open('branding/logos');
    await submit({ ...first.body, intent: 'apply' }, { bytes: PNG, name: 'logo.png' }).expect(303);

    const second = await open('branding/logos');
    const checked = await submit(
      { ...second.body, intent: 'check' },
      {
        bytes: SVG,
        name: 'logo.svg',
      },
    ).expect(200);
    /*
      And it *is* drawn, which it could not be while the picture lived in the
      document: the bytes are stored the moment they are accepted, so the page
      can show what was picked before anybody has pressed Save. Nothing was
      saved — the version count says so — and the row this left behind is what
      the sweep collects.
    */
    const form = checked.text.slice(checked.text.indexOf('<form class="spr-config"'));
    expect(form).toContain('SVG,');
    const thumb = /<img\s+class="spr-stored-thumb"\s+src="\/-\/config\/brand\/([0-9a-f]{64})"/.exec(
      form,
    )?.[1] as string;
    const drawn = await request(app.getHttpServer())
      .get(`/-/config/brand/${thumb}`)
      .set('cookie', ops)
      .expect(200);
    expect(Buffer.from(drawn.body).equals(SVG)).toBe(true);
    expect(await versionCount()).toBe(2);
  });

  it('removes it on the box beside it, on the same save', async () => {
    const first = await open('branding/logos');
    await submit({ ...first.body, intent: 'apply' }, { bytes: PNG, name: 'logo.png' }).expect(303);

    const second = await open('branding/logos');
    expect(second.html).toContain('name="remove:brand.logo"');
    await submit({ ...second.body, 'remove:brand.logo': 'on', intent: 'apply' }, null).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).not.toContain('logo:');
    expect(await versionCount()).toBe(3);
  });

  it('refuses a file that is not one of the three types, and saves nothing', async () => {
    const { body } = await open('branding/logos');
    const page = await submit(
      { ...body, intent: 'apply' },
      { bytes: Buffer.from('GIF89a...'), name: 'logo.gif' },
    ).expect(400);

    expect(page.text).toContain('not a PNG, a WebP or an SVG');
    expect(page.text).toContain('<form class="spr-config"');
    expect(await versionCount()).toBe(1);
  });

  it('refuses an SVG that points at another host', async () => {
    const { body } = await open('branding/logos');
    const page = await submit(
      { ...body, intent: 'apply' },
      {
        bytes: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.example/p.png"/></svg>',
        ),
        name: 'logo.svg',
      },
    ).expect(400);

    expect(page.text).toContain('outside itself');
    expect(await versionCount()).toBe(1);
  });

  it('offers one picker per image, and no other control', async () => {
    const { html, body } = await open('branding/logos');
    const form = html.slice(html.indexOf('<form class="spr-config"'));

    for (const picker of PICKERS) expect(form).toContain(`id="f-${picker}"`);
    expect((form.match(/type="file"/g) ?? []).length).toBe(3);
    // The name and the theme stay on the page above; this one is the images
    expect(Object.keys(body)).not.toContain('brand.name');
    expect(Object.keys(body)).not.toContain('theme.template');
  });

  it('offers each picker only what that image may be', async () => {
    const { html } = await open('branding/logos');
    const accept = (picker: string) =>
      new RegExp(`id="f-${picker.replace('.', '\\.')}"[\\s\\S]*?accept="([^"]+)"`).exec(html)?.[1];

    expect(accept('brand.logo')).toBe('image/svg+xml,image/png,image/webp');
    expect(accept('brand.logo_dark')).toBe('image/svg+xml,image/png,image/webp');
    expect(accept('brand.icon')).toBe('image/svg+xml,image/png');
  });

  it('takes a logo for each scheme and sends the header both', async () => {
    const { body } = await open('branding/logos');
    const posted = await submitFiles(
      { ...body, intent: 'apply' },
      {
        'brand.logo': { bytes: PNG, name: 'logo.png' },
        'brand.logo_dark': { bytes: SVG, name: 'logo-dark.svg' },
      },
    ).expect(303);
    const page = await landing('branding/logos', posted);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toMatch(/logo: sha256:[0-9a-f]{64}/);
    expect(yaml).toMatch(/logo_dark: sha256:[0-9a-f]{64}/);
    expect(yaml).not.toContain('base64,');

    const light = /<img class="spr-brand-logo spr-brand-logo-light" src="([^"]+)"/.exec(page.text);
    const dark = /<img class="spr-brand-logo spr-brand-logo-dark" src="([^"]+)"/.exec(page.text);
    expect(light?.[1]).toMatch(/^\/-\/brand\/[0-9a-f]{64}\.png$/);
    expect(dark?.[1]).toMatch(/^\/-\/brand\/[0-9a-f]{64}\.svg$/);

    for (const src of [light?.[1] as string, dark?.[1] as string]) {
      await request(app.getHttpServer()).get(src).expect(200);
    }
  });

  it('takes a tab icon, names it in the head and serves it forever', async () => {
    const { body } = await open('branding/logos');
    const posted = await submitFiles(
      { ...body, intent: 'apply' },
      { 'brand.icon': { bytes: pngSized(64, 64), name: 'icon.png' } },
    ).expect(303);
    const page = await landing('branding/logos', posted);

    const href = /<link rel="icon" href="([^"]+)" type="image\/png"/.exec(page.text)?.[1] as string;
    expect(href).toMatch(/^\/-\/brand\/[0-9a-f]{64}\.png$/);

    const served = await request(app.getHttpServer()).get(href).expect(200);
    expect(served.headers['cache-control']).toContain('immutable');
    expect(served.headers['content-type']).toContain('image/png');
  });

  it('refuses a tab icon that is not square, and says which field it means', async () => {
    const { body } = await open('branding/logos');
    const page = await submitFiles(
      { ...body, intent: 'apply' },
      { 'brand.icon': { bytes: pngSized(400, 80), name: 'wordmark.png' } },
    ).expect(400);

    expect(page.text).toContain('brand.icon');
    expect(page.text).toContain('400×80');
    expect(await versionCount()).toBe(1);
  });

  it('refuses a WebP for the tab icon, though a logo may be one', async () => {
    const { body } = await open('branding/logos');
    const refused = await submitFiles(
      { ...body, intent: 'apply' },
      { 'brand.icon': { bytes: WEBP, name: 'icon.webp' } },
    ).expect(400);
    expect(refused.text).toContain('may be an SVG or a PNG');

    const next = await open('branding/logos');
    await submitFiles(
      { ...next.body, intent: 'apply' },
      { 'brand.logo': { bytes: WEBP, name: 'logo.webp' } },
    ).expect(303);
    const stored = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    const webpHash = /logo: sha256:([0-9a-f]{64})/.exec(stored)?.[1] as string;
    expect(await brandImageExists(harness.tenantId, webpHash)).toBe(true);
  });

  describe('/favicon.ico', () => {
    it('answers with the default mark before an icon is configured', async () => {
      const served = await request(app.getHttpServer()).get('/favicon.ico').expect(200);
      expect(served.headers['content-type']).toContain('image/svg+xml');
      expect(served.headers['cache-control']).toContain('max-age=3600');
      // An SVG arrives as bytes rather than as text, being neither JSON nor HTML
      const svg = Buffer.from(served.body).toString('utf8');
      expect(svg).toContain('<svg');
      expect(svg).not.toMatch(/<script/i);
    });

    it('answers with the configured icon once there is one', async () => {
      const { body } = await open('branding/logos');
      await submitFiles(
        { ...body, intent: 'apply' },
        { 'brand.icon': { bytes: pngSized(64, 64), name: 'icon.png' } },
      ).expect(303);

      const served = await request(app.getHttpServer()).get('/favicon.ico').expect(200);
      expect(served.headers['content-type']).toContain('image/png');
      expect(Buffer.from(served.body).equals(pngSized(64, 64))).toBe(true);
      // Not immutable: the same path answers with other bytes after the next upload
      expect(served.headers['cache-control']).not.toContain('immutable');
    });
  });
});
describe('advanced settings', () => {
  it('draws the block at the foot of the form, with the questions above it', async () => {
    const { html } = await open('sources/gh');
    const form = html.slice(html.indexOf('<form class="spr-config"'));

    expect(form).toMatch(
      /name="forges\.gh\.default_repository_owner"[\s\S]*?<details class="spr-advanced"[\s\S]*?name="forges\.gh\.base_url"/,
    );
    expect(form).toContain('<details class="spr-advanced" >');
    expect(form).toContain('<summary>Advanced settings</summary>');
  });

  it('submits what it folded away, so a folded setting still saves', async () => {
    const { body } = await open('sources/gh');
    expect(Object.keys(body)).toContain('forges.gh.base_url');

    await post('sources/gh', {
      ...body,
      'forges.gh.base_url': 'https://github.internal.test',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('base_url: https://github.internal.test');
  });

  it('opens itself when a save comes back refused', async () => {
    const { body } = await open('sources/gh');
    const page = await post('sources/gh', {
      ...body,
      'forges.gh.private_key': 'not a key',
      intent: 'apply',
    }).expect(400);

    const form = page.text.slice(page.text.indexOf('<form class="spr-config"'));
    expect(form).toContain('<details class="spr-advanced" open>');
    expect(formBody(page.text)['forges.gh.base_url']).toBe(body['forges.gh.base_url']);
  });

  // Read analytics is disabled for now
  it.skip('draws no block on a page that has nothing to fold', async () => {
    const { html } = await open('analytics');
    expect(html).not.toContain('spr-advanced');
  });

  it('ships the island that opens the block a search result lands in', async () => {
    const { html } = await open('sources/gh');
    const src = /src="(\/-\/static\/config-[^"]+\.js)"/.exec(html)?.[1] as string;
    const island = await request(app.getHttpServer()).get(src).expect(200);
    expect(island.text).toContain('hashchange');
  });
});

describe('the GitHub App private key', () => {
  const KEY_FIELD = 'forges.gh.private_key';
  const PICKER = `file:${KEY_FIELD}`;

  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const PEM = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
  const PUBLIC_PEM = rsa.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const EC_PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string;
  const ENCRYPTED_PEM = rsa.privateKey.export({
    type: 'pkcs8',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase: 'hunter2',
  }) as string;

  function submit(body: FormBody, file: { bytes: Buffer; name: string } | null) {
    let req = request(app.getHttpServer()).post('/-/config/sources/gh').set('cookie', ops);
    for (const [name, value] of Object.entries(body)) {
      if (name.startsWith('file:')) continue;
      for (const one of Array.isArray(value) ? value : [value]) req = req.field(name, one);
    }
    if (file) req = req.attach(PICKER, file.bytes, file.name);
    return req;
  }

  async function storedKey(): Promise<string> {
    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    const block = /private_key:\s*(?:\|-?\n)?([\s\S]*?)\n\s{4}webhook_secret:/.exec(yaml);
    return (block?.[1] ?? '').replace(/^\s+/gm, '');
  }

  it('renders a picker beside the box, named for the field and never as it', async () => {
    const { html } = await open('sources/gh');
    const form = html.slice(html.indexOf('<form class="spr-config"'));

    expect(form).toMatch(
      new RegExp(
        `class="spr-pickable"[\\s\\S]*?name="${KEY_FIELD}"[\\s\\S]*?name="${PICKER}"[\\s\\S]*?</span>`,
      ),
    );
    expect(form).toContain('data-spr-drop-zone');
    expect(form).toContain(`name="${PICKER}"`);
    expect(form).not.toContain('name="file:forges.gh.webhook_secret"');
  });

  it('takes an uploaded .pem into the document as the key', async () => {
    const { body } = await open('sources/gh');
    await submit({ ...body, intent: 'apply' }, { bytes: Buffer.from(PEM), name: 'app.pem' }).expect(
      303,
    );

    const stored = createPrivateKey(await storedKey());
    expect(stored.export({ type: 'pkcs1', format: 'pem' })).toBe(PEM);
  });

  it('never renders back what it stored', async () => {
    const first = await open('sources/gh');
    expect(first.body[KEY_FIELD]).toBe('${TEST_GH_PRIVATE_KEY}');

    await submit(
      { ...first.body, intent: 'apply' },
      { bytes: Buffer.from(PEM), name: 'app.pem' },
    ).expect(303);

    const second = await open('sources/gh');
    expect(second.body[KEY_FIELD]).toBe('');
    expect(second.html).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(second.html).toContain('Configured. Type to replace it; blank keeps it.');

    const overview = await request(app.getHttpServer())
      .get('/-/config')
      .set('cookie', ops)
      .expect(200);
    expect(overview.text).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('keeps the stored key when the picker is left alone', async () => {
    const { body } = await open('sources/gh');
    await submit({ ...body, 'forges.gh.app_id': '4242', intent: 'apply' }, null).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('private_key: ${TEST_GH_PRIVATE_KEY}');
  });

  it('refuses a file that holds no private key, and keeps the edits', async () => {
    const { body } = await open('sources/gh');
    const page = await submit(
      { ...body, 'forges.gh.app_id': '4242', intent: 'apply' },
      { bytes: Buffer.from(PUBLIC_PEM), name: 'app.pem' },
    ).expect(400);

    expect(page.text).toContain('does not hold a private key');
    expect(await versionCount()).toBe(1);
    expect(formBody(page.text)['forges.gh.app_id']).toBe('4242');
  });

  it('refuses a key that is not RSA, which the header does not say', async () => {
    const { body } = await open('sources/gh');
    const page = await submit(
      { ...body, intent: 'apply' },
      {
        bytes: Buffer.from(EC_PEM),
        name: 'app.pem',
      },
    ).expect(400);

    expect(page.text).toContain('signs with RSA');
    expect(await versionCount()).toBe(1);
  });

  it('refuses a passphrase-protected key by saying that is what it is', async () => {
    const { body } = await open('sources/gh');
    const page = await submit(
      { ...body, intent: 'apply' },
      {
        bytes: Buffer.from(ENCRYPTED_PEM),
        name: 'app.pem',
      },
    ).expect(400);

    expect(page.text).toContain('protected by a passphrase');
    expect(await versionCount()).toBe(1);
  });

  it('refuses a file that is not text before it looks for a key in it', async () => {
    const { body } = await open('sources/gh');
    const page = await submit(
      { ...body, intent: 'apply' },
      {
        bytes: Buffer.from([0x30, 0x82, 0x04, 0x00, 0x02, 0x01, 0x03]),
        name: 'app.p12',
      },
    ).expect(400);

    expect(page.text).toContain('is not text');
    expect(await versionCount()).toBe(1);
  });

  it('ignores a file posted at a control the page does not offer', async () => {
    const { body } = await open('sources/gh');
    let req = request(app.getHttpServer()).post('/-/config/sources/gh').set('cookie', ops);
    for (const [name, value] of Object.entries({ ...body, intent: 'apply' })) {
      if (name.startsWith('file:')) continue;
      for (const one of Array.isArray(value) ? value : [value]) req = req.field(name, one);
    }
    await req
      .attach('file:forges.gh.webhook_secret', Buffer.from(PEM), 'app.pem')
      .attach('file:admins.users.0.subject', Buffer.from(PEM), 'app.pem')
      .expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('webhook_secret: ${TEST_GH_WEBHOOK_SECRET}');
    expect(yaml).not.toContain('BEGIN RSA PRIVATE KEY');
  });
});

describe('adding and removing entries', () => {
  it('sends the operator to the new provider’s page, and writes nothing', async () => {
    expect(await addEntry('identity', 'okta', 'oidc')).toBe('/-/config/identity/okta?kind=oidc');

    const page = await request(app.getHttpServer())
      .get('/-/config/identity/okta?kind=oidc')
      .set('cookie', ops)
      .expect(200);

    expect(formNames(page.text)).toContain('auth.providers.okta.issuer');
    expect(page.text).toContain('data-spr-pending');
    expect(await versionCount()).toBe(1);
  });

  it('arrives with every default already in its box', async () => {
    await addEntry('identity', 'letter', 'magic-link');
    const draft = await open('identity/letter?kind=magic-link');

    expect(draft.body['auth.providers.letter.token_ttl']).toBe('15');
    expect(draft.body['unit:auth.providers.letter.token_ttl']).toBe('m');
    expect(draft.body['auth.providers.letter.session_ttl']).toBe('30');
    expect(draft.body['unit:auth.providers.letter.session_ttl']).toBe('d');
    const oidc = await open('identity/okta?kind=oidc');
    expect(oidc.body['auth.providers.okta.subject_claim']).toBe('sub');
    expect(oidc.body['auth.providers.okta.session_ttl']).toBe('8');
    expect(oidc.body['unit:auth.providers.okta.session_ttl']).toBe('h');
    expect(oidc.body['auth.providers.okta.issuer']).toBe('');
    expect(oidc.body['auth.providers.okta.client_id']).toBe('');
  });

  it('stores none of those defaults, because they are what a default means', async () => {
    await addEntry('identity', 'okta', 'oidc');
    const draft = await open('identity/okta?kind=oidc');
    expect(draft.body['auth.providers.okta.subject_claim']).toBe('sub');

    await post('identity/okta?kind=oidc', {
      ...draft.body,
      'auth.providers.okta.issuer': 'https://okta.example.test/oauth2/default',
      'auth.providers.okta.client_id': 'okta-client',
      intent: 'apply',
    }).expect(303);

    const block = providerBlock(
      (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '',
      'okta',
    );
    expect(block).toContain('type: oidc');
    expect(block).toContain('okta-client');
    expect(block).not.toContain('subject_claim');
    expect(block).not.toContain('session_ttl');
  });

  it('404s the page of a provider that neither exists nor is being made', async () => {
    await request(app.getHttpServer())
      .get('/-/config/identity/okta')
      .set('cookie', ops)
      .expect(404);
    await request(app.getHttpServer())
      .get('/-/config/identity/okta?kind=ldap')
      .set('cookie', ops)
      .expect(404);
  });

  it('ignores an add whose name is not a provider id', async () => {
    const page = await request(app.getHttpServer())
      .get('/-/config/identity')
      .query({ add: 'Not A Provider', kind: 'oidc' })
      .set('cookie', ops)
      .expect(200);
    expect(page.text).toMatch(titledHeading(titleOf('identity')));
  });

  it('keeps edits made before the add button was pressed', async () => {
    const { body } = await open('groups/engineering/entra');
    const page = await post('groups/engineering/entra', {
      ...body,
      'groups.engineering.0.id': 'grp-eng-renamed',
      op: 'add:groups.engineering.provider.entra',
    }).expect(200);

    const after = formBody(page.text);
    expect(after['groups.engineering.0.id']).toBe('grp-eng-renamed');
    expect(after['groups.engineering.1.provider']).toBe('entra');
  });

  it('removes an entry', async () => {
    const { body } = await open('groups');
    const page = await post('groups', { ...body, op: 'remove:groups.client-northwind' }).expect(
      200,
    );
    expect(page.text).not.toContain('>client-northwind<');
    expect(String(formBody(page.text)['__shape:groups'])).not.toContain('client-northwind');
    expect(await versionCount()).toBe(1);
  });

  it('keeps a removal through the save that follows it', async () => {
    const { body } = await open('groups');
    const afterRemove = await post('groups', {
      ...body,
      op: 'remove:groups.client-northwind',
    }).expect(200);

    await post('groups', { ...formBody(afterRemove.text), intent: 'apply' }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).not.toContain('client-northwind');
    expect(yaml).toContain('engineering:');
    expect(yaml).toContain('platform-ops:');
  });

  it('creates the provider when its page is saved, and disturbs no other', async () => {
    await addEntry('identity', 'okta', 'oidc');
    const draft = await open('identity/okta?kind=oidc');

    expect(draft.html).toContain('action="/-/config/identity/okta?kind=oidc#spr-landing"');

    await post('identity/okta?kind=oidc', {
      ...draft.body,
      'auth.providers.okta.issuer': 'https://okta.example.test/oauth2/default',
      'auth.providers.okta.client_id': 'okta-client',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('okta:');
    expect(yaml).toContain('https://okta.example.test/oauth2/default');
    expect(yaml).toContain('entra:');

    const index = await open('identity');
    expect(index.html).toContain('href="/-/config/identity/okta"');
  });

  it('creates nothing from a page whose provider is not the one it names', async () => {
    await addEntry('identity', 'okta', 'oidc');
    const draft = await open('identity/okta?kind=oidc');

    await post('identity/okta?kind=oidc', {
      ...draft.body,
      'auth.providers.okta.issuer': 'https://okta.example.test/oauth2/default',
      'auth.providers.okta.client_id': 'okta-client',
      'auth.providers.backdoor.type': 'oidc',
      'auth.providers.backdoor.issuer': 'https://evil.test',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).not.toContain('backdoor');
    expect(yaml).not.toContain('evil.test');
  });

  it('removes a provider from the index, and keeps it through the save', async () => {
    await addEntry('identity', 'okta', 'oidc');
    await post('identity/okta?kind=oidc', {
      ...(await open('identity/okta?kind=oidc')).body,
      'auth.providers.okta.issuer': 'https://okta.example.test/oauth2/default',
      'auth.providers.okta.client_id': 'okta-client',
      intent: 'apply',
    }).expect(303);

    const page = await open('identity/okta');
    expect(page.html).toContain('Remove this provider');
    expect(page.html).toContain('formaction="/-/config/identity"');
    expect(page.html).toContain('value="remove:auth.providers.okta"');

    const { body } = await open('identity');
    const afterRemove = await post('identity', {
      ...body,
      op: 'remove:auth.providers.okta',
    }).expect(200);
    expect(afterRemove.text).not.toContain('href="/-/config/identity/okta"');

    await post('identity', { ...formBody(afterRemove.text), intent: 'apply' }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).not.toContain('okta:');
    expect(yaml).toContain('entra:');
    await request(app.getHttpServer())
      .get('/-/config/identity/okta')
      .set('cookie', ops)
      .expect(404);
  });

  it('offers no way to remove the last provider, and refuses one anyway', async () => {
    const page = await open('identity/entra');
    expect(page.html).not.toContain('Remove this provider');

    const { body } = await open('identity');
    await post('identity', { ...body, op: 'remove:auth.providers.entra' }).expect(200);
    await post('identity', { ...body, intent: 'apply' }).expect(303);

    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toContain('entra:');
  });

  it('renames a provider, and takes every grant that names it along', async () => {
    const page = await open('identity/entra');
    expect(page.html).toContain('value="rename:auth.providers.entra"');
    expect(page.html).toMatch(/<summary[^>]*aria-label="Rename entra"><svg class="spr-icon"/);
    expect(page.html).toContain('form="config-form"');
    expect(page.html).toContain('<details class="spr-modal spr-rename">');
    expect(page.html).toContain('class="spr-modal-panel"');
    expect(page.html).toContain('enqueue a full rebuild');
    expect(page.html).toMatch(/repositor(y|ies)/);

    const renamed = await post('identity/entra', {
      ...page.body,
      rename: 'microsoft',
      op: 'rename:auth.providers.entra',
    }).expect(303);
    expect(renamed.headers.location).toMatch(/^\/-\/config\/identity\/microsoft\?saved=\d+$/);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('microsoft:');
    expect(yaml).toMatch(/default_provider: microsoft/);
    expect(yaml).toMatch(/provider: microsoft/);
    expect(yaml).not.toMatch(/\bentra\b/);

    await request(app.getHttpServer())
      .get('/-/config/identity/microsoft')
      .set('cookie', ops)
      .expect(200);

    await request(app.getHttpServer())
      .get('/-/config/identity/entra')
      .set('cookie', ops)
      .expect(404);

    const signedInAgain = await sessionCookieFor(harness.tenantId, 'ops', 'microsoft');
    await request(app.getHttpServer())
      .get('/-/config/identity/microsoft')
      .set('cookie', signedInAgain)
      .expect(200);
  });

  it('carries every credential minted under a provider through its rename', async () => {
    const sequelize = getSequelize();
    const now = new Date(Date.now() + 3600_000);
    const seed = async (table: string, columns: Record<string, unknown>): Promise<void> => {
      const keys = Object.keys(columns);
      await sequelize.query(
        `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => `:${k}`).join(', ')})`,
        { replacements: columns },
      );
    };

    await seed('api_keys', {
      tenant_id: harness.tenantId,
      principal: 'user:entra:carried',
      provider: 'entra',
      subject: 'carried',
      email: 'carried@copetence.test',
      name: 'carried key',
      hash: 'carried-key-hash',
      expires_at: now,
    });
    await seed('oauth_grants', {
      tenant_id: harness.tenantId,
      principal: 'user:entra:carried',
      client_id: 'https://client.example.test/metadata.json',
      resource: 'https://speicher.example.test/mcp',
      access_hash: 'carried-access-hash',
      refresh_hash: 'carried-refresh-hash',
      provider: 'entra',
      subject: 'carried',
      access_expires_at: now,
      refresh_expires_at: now,
    });
    await seed('login_flows', {
      tenant_id: harness.tenantId,
      provider: 'entra',
      state: 'carried-state',
      nonce: 'carried-nonce',
      code_verifier: 'carried-verifier',
      expires_at: now,
    });
    await seed('magic_link_tokens', {
      tenant_id: harness.tenantId,
      provider: 'entra',
      email: 'carried@copetence.test',
      token_hash: 'carried-magic-hash',
      expires_at: now,
    });

    const page = await open('identity/entra');
    await post('identity/entra', {
      ...page.body,
      rename: 'microsoft',
      op: 'rename:auth.providers.entra',
    }).expect(303);

    for (const table of [
      'sessions',
      'api_keys',
      'oauth_grants',
      'login_flows',
      'magic_link_tokens',
    ]) {
      const [rows] = await sequelize.query(
        `SELECT provider FROM ${table} WHERE tenant_id = :tenant`,
        { replacements: { tenant: harness.tenantId } },
      );
      const providers = (rows as { provider: string }[]).map((row) => row.provider);
      expect(providers.length).toBeGreaterThan(0);
      expect(providers).not.toContain('entra');
      expect(providers).toContain('microsoft');
    }
  });

  it('refuses a name that is taken, and changes nothing', async () => {
    await addEntry('identity', 'okta', 'oidc');
    await post('identity/okta?kind=oidc', {
      ...(await open('identity/okta?kind=oidc')).body,
      'auth.providers.okta.issuer': 'https://okta.example.test/oauth2/default',
      'auth.providers.okta.client_id': 'okta-client',
      intent: 'apply',
    }).expect(303);

    const before = await versionCount();
    const page = await open('identity/okta');
    const refused = await post('identity/okta', {
      ...page.body,
      rename: 'entra',
      op: 'rename:auth.providers.okta',
    }).expect(400);

    expect(refused.text).toContain('already a provider called');
    expect(await versionCount()).toBe(before);
  });

  it('refuses a rename the page did not offer', async () => {
    const before = await versionCount();
    const page = await open('identity/entra');
    await post('identity/entra', {
      ...page.body,
      rename: 'stolen',
      op: 'rename:auth.providers.letter',
    }).expect(200);

    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).not.toContain('stolen');
    expect(await versionCount()).toBe(before);
  });

  it('offers no rename while the provider is being created', async () => {
    await addEntry('identity', 'okta', 'oidc');
    const draft = await open('identity/okta?kind=oidc');
    expect(draft.html).not.toContain('rename:auth.providers.okta');
  });

  it('cannot delete a provider from another provider’s page', async () => {
    const { body } = await open('identity/entra');
    await post('identity/entra', {
      ...body,
      '__shape:auth.providers': '',
      intent: 'apply',
    }).expect(303);

    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toContain('entra:');
  });

  it('keeps the kind an added entry was given, not the default one', async () => {
    const mail = await open('mail');
    await post('mail', {
      ...mail.body,
      'mail.host': 'smtp.example.test',
      'mail.from': 'Docs <docs@example.test>',
      intent: 'apply',
    }).expect(303);

    await addEntry('identity', 'letter', 'magic-link');
    const draft = await open('identity/letter?kind=magic-link');
    expect(Object.keys(draft.body)).toContain('auth.providers.letter.token_ttl');

    await post('identity/letter?kind=magic-link', {
      ...draft.body,
      'auth.providers.letter.token_ttl': '20',
      'unit:auth.providers.letter.token_ttl': 'm',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('type: magic-link');
    expect(yaml).toContain('token_ttl: 20m');
  });

  it('removes the source a group no longer has, and keeps the ones it does', async () => {
    const { body } = await open('groups/engineering/entra');
    const twoSources = await post('groups/engineering/entra', {
      ...body,
      op: 'add:groups.engineering.provider.entra',
    }).expect(200);

    const filled = formBody(twoSources.text);
    expect(Object.keys(filled)).toContain('groups.engineering.1.provider');
    await post('groups/engineering/entra', {
      ...filled,
      'groups.engineering.1.id': 'grp-eng-two',
      intent: 'apply',
    }).expect(303);
    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toContain('grp-eng-two');

    const both = await open('groups/engineering/entra');
    const afterRemove = await post('groups/engineering/entra', {
      ...both.body,
      op: 'remove:groups.engineering.0',
    }).expect(200);
    await post('groups/engineering/entra', {
      ...formBody(afterRemove.text),
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('grp-eng-two');
    expect(yaml).not.toContain('grp-eng"');
    expect(yaml).not.toContain("'grp-eng'");
  });

  it('ignores an operation the form did not offer', async () => {
    const { body } = await open('admins');
    const page = await post('admins', { ...body, op: 'remove:admins' }).expect(200);
    expect(Object.keys(formBody(page.text))).toEqual(['__shape:admins.users']);
    expect(await versionCount()).toBe(1);
  });
});

// Read analytics is disabled for now
describe.skip('the analytics section', () => {
  it('breaks the row before the first box, and only there', async () => {
    const { html } = await open('analytics');

    const fieldOf = (path: string): string => {
      const at = html.indexOf(`name="${path}"`);
      expect(at).toBeGreaterThan(-1);
      return html.slice(html.lastIndexOf('class="spr-field spr-field-', at), at);
    };

    expect(fieldOf('analytics.timezone')).toContain('spr-field-break');
    for (const path of [
      'analytics.enabled',
      'analytics.unique_readers',
      'analytics.public_beacon',
      'analytics.granularity',
      'analytics.retention_days',
      'analytics.search_retention_days',
    ]) {
      expect(fieldOf(path)).not.toContain('spr-field-break');
    }
  });
});

describe('the public repositories', () => {
  const rowsOf = (html: string) =>
    [...html.matchAll(/<input type="hidden" name="public\.repos" value="([^"]+)">/g)].map(
      (m) => m[1],
    );
  const offeredBy = (html: string) =>
    [...html.matchAll(/<input type="checkbox" name="add:public\.repos" value="([^"]+)"/g)].map(
      (m) => m[1],
    );
  const rowOf = (html: string, value: string) => {
    const from = html.indexOf(`<input type="hidden" name="public.repos" value="${value}">`);
    return html.slice(from, html.indexOf('</li>', from));
  };

  it('lists the stored entries, and offers every other repository Speicher knows', async () => {
    const { html } = await open('public');
    expect(rowsOf(html)).toEqual(['copetence/speicher-docs']);
    expect(html).toMatch(/name="remove:public\.repos"\s+value="copetence\/speicher-docs"/);
    expect(offeredBy(html)).toEqual([
      'copetence/fieldkit',
      'copetence/handbook',
      'northwind-engineering/specs',
    ]);
    expect(html).not.toContain('<textarea');
  });

  it('says nothing about a repository that publishes', async () => {
    const { html } = await open('public');
    expect(rowOf(html, 'copetence/speicher-docs')).not.toContain('spr-info');
  });

  it('offers the repositories in a modal, each with what is known about it', async () => {
    const { html } = await open('public');
    expect(html).toMatch(/<details class="spr-modal spr-pick-list-modal">/);
    const handbook = html.slice(html.indexOf('value="copetence/handbook" data-spr-transient'));
    expect(handbook.slice(0, handbook.indexOf('</label>'))).toMatch(
      /spr-info-mark-warn[\s\S]*?role="tooltip"[\s\S]*?does not grant public access/,
    );
  });

  it('adds every ticked repository, and stores nothing until Save', async () => {
    const before = await versionCount();
    const res = await post('public', {
      'public.repos': ['copetence/speicher-docs'],
      'add:public.repos': ['copetence/handbook', 'copetence/fieldkit'],
    }).expect(200);

    expect(rowsOf(res.text)).toEqual([
      'copetence/speicher-docs',
      'copetence/handbook',
      'copetence/fieldkit',
    ]);
    expect(offeredBy(res.text)).toEqual(['northwind-engineering/specs']);
    expect(await versionCount()).toBe(before);
  });

  it('warns that a listed repository stays private while its .speicher.yaml does not grant public', async () => {
    const res = await post('public', {
      'public.repos': ['copetence/speicher-docs'],
      'add:public.repos': 'copetence/handbook',
    }).expect(200);

    expect(rowOf(res.text, 'copetence/handbook')).toMatch(
      /spr-info-mark-warn[\s\S]*?role="tooltip"[\s\S]*?does not grant public access/,
    );
  });

  it('empties the list when every row was taken out in the page', async () => {
    const response = await post('public', {
      '__pick:public.repos': '',
      intent: 'apply',
    }).expect(303);
    await landing('public', response);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toMatch(/repos:\s*\[\]/);
  });

  it('marks an entry Speicher does not know, and keeps it', async () => {
    const res = await post('public', {
      'public.repos': ['copetence/speicher-docs', 'old-team/renamed'],
      'add:public.repos': '',
    }).expect(200);

    expect(rowsOf(res.text)).toEqual(['copetence/speicher-docs', 'old-team/renamed']);
    expect(res.text).toContain('Speicher does not know this repository.');
  });

  it('takes the entry out on Remove, and stores nothing until Save', async () => {
    const before = await versionCount();
    const res = await post('public', {
      'public.repos': ['copetence/speicher-docs'],
      'add:public.repos': '',
      'remove:public.repos': 'copetence/speicher-docs',
    }).expect(200);

    expect(rowsOf(res.text)).toEqual([]);
    expect(res.text).toContain('No repository may publish to public readers yet.');
    expect(offeredBy(res.text)).toContain('copetence/speicher-docs');
    expect(await versionCount()).toBe(before);
  });

  it('stores the list on Save', async () => {
    const response = await post('public', {
      'public.repos': ['copetence/speicher-docs'],
      'add:public.repos': 'copetence/handbook',
      intent: 'apply',
    }).expect(303);
    await landing('public', response);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toMatch(/repos:\s*\n\s*- copetence\/speicher-docs\s*\n\s*- copetence\/handbook/);
  });
});

describe('the transport and the notices', () => {
  it('puts the relay on one page, reaching no notice from it', async () => {
    const { html, body } = await open('mail');

    expect(Object.keys(body)).toContain('mail.host');
    expect(html).toContain('name="mail.password"');
    expect(html).not.toContain('name="notify.');
    expect(html).not.toContain('__shape:');
    expect(html).not.toContain('href="/-/config/mail/');
  });

  // Notifications is disabled for now
  it.skip('puts every notice on one page, a card each, reaching no transport control', async () => {
    const { html } = await open('notifications');

    for (const name of [
      'notify.sync_failure',
      'notify.stale',
      'notify.stale_after',
      'notify.grant_expiry',
      'notify.expiry_warning',
    ]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).not.toContain('name="mail.');

    expect([...html.matchAll(/class="spr-card spr-card-1"/g)]).toHaveLength(3);
    for (const title of ['Failed syncs', 'Stale repositories', 'Expiring grants']) {
      expect(html).toContain(title);
    }
    expect(html).not.toContain('spr-card-key');

    await appendConfigVersion(harness.tenantId, {
      yaml: FIXTURE_YAML.replace(
        'forges:\n',
        'forges:\n' +
          '  onprem:\n' +
          '    type: git\n' +
          '    repos:\n' +
          '      - id: runbooks\n' +
          '        url: https://example.test/internal/runbooks.git\n' +
          '        slug: runbooks\n' +
          '        branch: main\n',
      ),
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });
    const source = await open('sources/onprem');
    expect(source.html).toContain('spr-card-key');
    expect(source.html).toContain('runbooks');
    // The Add button follows the last repository, not the security card after it
    const added = source.html.indexOf('Add a repository');
    expect(added).toBeGreaterThan(source.html.indexOf('remove:forges.onprem.repos.0'));
    expect(added).toBeLessThan(source.html.indexOf('Known hosts'));
  });

  it('keeps a secret typed before a round trip, and saves it with the next save', async () => {
    await appendConfigVersion(harness.tenantId, {
      yaml: FIXTURE_YAML.replace(
        'forges:\n',
        'forges:\n' +
          '  onprem:\n' +
          '    type: git\n' +
          '    repos:\n' +
          '      - id: runbooks\n' +
          '        url: https://example.test/internal/runbooks.git\n',
      ),
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });
    const token = 'forges.onprem.repos.0.token';

    const { body } = await open('sources/onprem');
    const added = await post('sources/onprem', {
      ...body,
      [token]: 'typed-token',
      // Check changes is a round trip too, and unlike Add it leaves a document that saves
      intent: 'check',
    }).expect(200);
    expect(added.text).toContain(`name="unsaved:${token}" value="typed-token"`);
    expect(added.text).toContain('Not saved yet');
    expect(added.text).not.toMatch(new RegExp(`name="${token}"[^>]*value="typed-token"`));

    const next = formBody(added.text);
    expect(next[token]).toBe('');
    await post('sources/onprem', { ...next, intent: 'apply' }).expect(303);
    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toContain('token: typed-token');
  });

  it("fetches the host keys of a git source's ssh server as a round trip that stores nothing", async () => {
    await appendConfigVersion(harness.tenantId, {
      yaml: FIXTURE_YAML.replace(
        'forges:\n',
        'forges:\n' +
          '  onprem:\n' +
          '    type: git\n' +
          '    known_hosts: example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnly\n' +
          '    repos:\n' +
          '      - id: runbooks\n' +
          '        url: ssh://git@example.test/internal/runbooks.git\n' +
          '        slug: runbooks\n' +
          '        branch: main\n' +
          '        deploy_key: ${TEST_GH_PRIVATE_KEY}\n',
      ),
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });
    const op = 'fetch-host-keys:forges.onprem.known_hosts';

    const { html, body } = await open('sources/onprem');
    expect(html).toContain(`value="${op}"`);
    expect(html).toMatch(/<td><code>example\.test<\/code><\/td>\s*<td>ssh-ed25519<\/td>/);
    expect(html).toContain('<summary>Edit manually</summary>');

    // example.test never answers, so the page comes back saying so, with nothing stored
    const before = await versionCount();
    const answer = await post('sources/onprem', { ...body, op }).expect(200);
    expect(answer.text).toContain('No keys fetched');
    expect(answer.text).toContain(`value="${op}"`);
    expect(await versionCount()).toBe(before);
    // The page opens at the card holding the known hosts, and only there
    expect(html).not.toContain('id="spr-landing"');
    expect(answer.text.match(/id="spr-landing"/g)).toHaveLength(1);
    const card = answer.text.slice(answer.text.indexOf('id="spr-landing"'));
    expect(card.indexOf('Known hosts')).toBeLessThan(card.indexOf('</section>'));
  });

  it('marks the required fields of a plain remote with an asterisk', async () => {
    await appendConfigVersion(harness.tenantId, {
      yaml: FIXTURE_YAML.replace(
        'forges:\n',
        'forges:\n' +
          '  onprem:\n' +
          '    type: git\n' +
          '    known_hosts: example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnly\n' +
          '    repos:\n' +
          '      - id: runbooks\n' +
          '        url: ssh://git@example.test/internal/runbooks.git\n' +
          '        deploy_key: ${TEST_GH_PRIVATE_KEY}\n',
      ),
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });

    const { html } = await open('sources/onprem');
    const marked = [
      ...html.matchAll(/>\s*([^<>]+?)<span class="spr-required" aria-hidden="true">\*<\/span>/g),
    ].map((m) => m[1].trim());
    expect(marked).toEqual(['Remote URL', 'Access token', 'Deploy key', 'Known hosts']);
    expect(html).toContain('<span class="spr-clipped"> (required)</span>');
  });

  it('offers a connection check under each remote URL, and answers it for that repository', async () => {
    await appendConfigVersion(harness.tenantId, {
      yaml: FIXTURE_YAML.replace(
        'forges:\n',
        'forges:\n' +
          '  onprem:\n' +
          '    type: git\n' +
          '    repos:\n' +
          '      - id: docs\n' +
          // A port nothing listens on, so the check fails at once and without a network
          '        url: https://127.0.0.1:9/internal/docs.git\n' +
          '        token: t\n',
      ),
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });
    const path = 'forges.onprem.repos.0.url';
    const href = `/-/config/sources/onprem?check=${encodeURIComponent(path)}`;

    const { html } = await open('sources/onprem');
    expect(html).toContain(`data-spr-check="${href}" data-spr-check-at="${path}"`);

    const { body } = await request(app.getHttpServer())
      .get(href)
      .set('cookie', ops)
      .set('accept', 'application/json')
      .expect(200);
    const field = allFields([body.section as FormSection]).find((each) => each.path === path);
    expect(field?.status).toMatchObject({ level: 'fail', label: 'Cannot connect' });
  });

  it('hides the security card of a plain remote until a repository uses SSH', async () => {
    const securityCard = async (url: string) => {
      await appendConfigVersion(harness.tenantId, {
        yaml: FIXTURE_YAML.replace(
          'forges:\n',
          'forges:\n' +
            '  onprem:\n' +
            '    type: git\n' +
            '    known_hosts: example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnly\n' +
            '    repos:\n' +
            '      - id: runbooks\n' +
            `        url: ${url}\n`,
        ),
        resolutionHash: 'x',
        origin: 'admin',
        appliedBy: null,
      });
      const { html } = await open('sources/onprem');
      const at = html.search(/<h4>\s*Security\s*<\/h4>/);
      return html.slice(html.lastIndexOf('<section', at), at);
    };

    expect(await securityCard('https://example.test/internal/runbooks.git')).toMatch(/\shidden\s/);
    expect(await securityCard('ssh://git@example.test/internal/runbooks.git')).not.toMatch(
      /\shidden\s/,
    );
  });

  it('folds the URL slug and the poll interval of a repository into its card', async () => {
    await appendConfigVersion(harness.tenantId, {
      yaml: FIXTURE_YAML.replace(
        'forges:\n',
        'forges:\n' +
          '  onprem:\n' +
          '    type: git\n' +
          '    repos:\n' +
          '      - id: runbooks\n' +
          '        url: https://example.test/internal/runbooks.git\n' +
          '      - id: handbook\n' +
          '        url: https://example.test/internal/handbook.git\n' +
          '        slug: guide\n',
      ),
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });

    const { html } = await open('sources/onprem');
    const card = (id: string) => {
      const at = html.search(new RegExp(`<h4>\\s*${id}\\s*</h4>`));
      return html.slice(at, html.indexOf('</section>', at));
    };
    for (const id of ['runbooks', 'handbook']) {
      const folded = card(id).slice(card(id).indexOf('<details class="spr-advanced"'));
      expect(folded).toContain('name="forges.onprem.repos.');
      expect(folded).toMatch(/name="forges\.onprem\.repos\.\d\.slug"/);
      expect(folded).toMatch(/name="forges\.onprem\.repos\.\d\.poll_interval"/);
      expect(folded).not.toMatch(/name="forges\.onprem\.repos\.\d\.branch"/);
    }
    // Closed while the folded fields are empty, open once one holds a value
    expect(card('runbooks')).toContain('<details class="spr-advanced" >');
    expect(card('handbook')).toContain('<details class="spr-advanced" open>');
  });

  // Notifications is disabled for now
  it.skip('saves one notice without touching the ones beside it', async () => {
    await appendConfigVersion(harness.tenantId, {
      yaml: `${FIXTURE_YAML}\nnotify:\n  sync_failure: [admins, committer]\n  grant_expiry: [admins]\n`,
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });

    const { body } = await open('notifications');
    await post('notifications', {
      ...body,
      'notify.stale_after': '48',
      'unit:notify.stale_after': 'h',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('stale_after: 48h');
    expect(yaml).toContain('sync_failure:');
    expect(yaml).toContain('committer');
    expect(yaml).toContain('grant_expiry:');
  });

  // Notifications is disabled for now
  it.skip('leaves the relay alone when the notices are saved', async () => {
    await appendConfigVersion(harness.tenantId, {
      yaml:
        `${FIXTURE_YAML}\nmail:\n  host: relay.example.test\n  from: Docs <docs@example.test>\n` +
        `notify:\n  grant_expiry: [admins]\n`,
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });

    const notices = await open('notifications');
    await post('notifications', { ...notices.body, intent: 'apply' }).expect(303);
    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toContain(
      'host: relay.example.test',
    );
  });

  it('leaves the notices alone when the relay is saved, even with their page disabled', async () => {
    await appendConfigVersion(harness.tenantId, {
      yaml:
        `${FIXTURE_YAML}\nmail:\n  host: relay.example.test\n  from: Docs <docs@example.test>\n` +
        `notify:\n  grant_expiry: [admins]\n`,
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });

    const mail = await open('mail');
    await post('mail', { ...mail.body, 'mail.host': 'other.example.test', intent: 'apply' }).expect(
      303,
    );
    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('host: other.example.test');
    expect(yaml).toContain('grant_expiry:');
  });

  it('404s a disabled section to an admin, as a page, as JSON and as a save', async () => {
    for (const section of ['analytics', 'notifications', 'embedding']) {
      await request(app.getHttpServer()).get(`/-/config/${section}`).set('cookie', ops).expect(404);
      await request(app.getHttpServer())
        .get(`/-/config/${section}`)
        .set('cookie', ops)
        .set('accept', 'application/json')
        .expect(404);
      await post(section, { intent: 'apply' }).expect(404);
    }
  });

  it('404s the pages the split retired, and every other spelling of them', async () => {
    for (const gone of [
      'mail/smtp',
      'mail/sync-failure',
      'mail/stale',
      'mail/grant-expiry',
      'mail/nonsense',
      'notifications/stale',
    ]) {
      await request(app.getHttpServer()).get(`/-/config/${gone}`).set('cookie', ops).expect(404);
    }
    await request(app.getHttpServer())
      .get('/-/config/branding%2Fappearance')
      .set('cookie', ops)
      .expect(404);
    await request(app.getHttpServer())
      .get('/-/config/branding/appearance')
      .set('cookie', ops)
      .expect(200);
  });
});

describe('the administrators section', () => {
  it('offers no control over which groups grant it, and says where that lives', async () => {
    const { html, body } = await open('admins');
    expect(Object.keys(body)).not.toContain('admins.groups');
    expect(html).not.toContain('name="admins.groups"');
    expect(html).toContain('href="/-/config/groups?q=administrators"');
  });

  it('links to a query that really does list the groups that grant it', async () => {
    const page = await request(app.getHttpServer())
      .get('/-/config/groups')
      .query({ q: 'administrators' })
      .set('cookie', ops)
      .expect(200);
    expect(page.text).toContain('href="/-/config/groups/platform-ops"');
    expect(page.text).not.toContain('href="/-/config/groups/engineering"');
  });

  it('still names people one at a time, which no group can do', async () => {
    const index = await open('admins');
    expect(index.html).toContain('href="/-/config/admins/0"');

    const draft = await open('admins/0');
    expect(draft.html).toContain('data-spr-pending');
    expect(Object.keys(draft.body)).toContain('admins.users.0.subject');
    expect(Object.keys(draft.body)).toContain('admins.users.0.note');
    expect(await versionCount()).toBe(1);

    await post('admins/0', {
      ...draft.body,
      'admins.users.0.subject': 'ops-oid',
      'admins.users.0.note': 'the founding administrator',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('ops-oid');
    expect(yaml).toMatch(/groups: \[\s*platform-ops\s*\]/);
  });

  async function addAdmin(subject: string, note: string, until?: string): Promise<void> {
    const at = String(formBody((await open('admins')).html)['__shape:admins.users']);
    const draft = await open(`admins/${at}`);
    await post(`admins/${at}`, {
      ...draft.body,
      [`admins.users.${at}.subject`]: subject,
      [`admins.users.${at}.note`]: note,
      ...(until ? { [`admins.users.${at}.until`]: until } : {}),
      intent: 'apply',
    }).expect(303);
  }

  it('lists them as rows that open them, and carries their values', async () => {
    await addAdmin('ops-oid', 'the founding administrator', '2027-01-01');

    const { html } = await open('admins');
    const table = html.slice(html.indexOf('spr-entries'), html.indexOf('</table>'));

    expect(table).toContain('<th scope="col">Administrator</th>');
    expect(table).toContain('<th scope="col">Why</th>');
    expect(table).toContain('href="/-/config/admins/0"');
    expect(table).toContain('ops-oid');
    expect(table).toContain('the founding administrator');
    expect(table).toMatch(
      /<span class="spr-line-label">Expires<\/span>\s*<code>2027-01-01<\/code>/,
    );
    expect(table).toContain('<input type="hidden" name="admins.users.0.subject" value="ops-oid">');
  });

  it('marks a grant made by address, which is the reassignable kind', async () => {
    const at = String(formBody((await open('admins')).html)['__shape:admins.users']);
    const draft = await open(`admins/${at}`);
    await post(`admins/${at}`, {
      ...draft.body,
      [`admins.users.${at}.email`]: 'ops@example.test',
      intent: 'apply',
    }).expect(303);

    const { html } = await open('admins');
    expect(html).toMatch(/ops@example\.test[\s\S]*?>By address</);
  });

  it('keeps the right administrators when the middle one is removed', async () => {
    await addAdmin('first-oid', 'one');
    await addAdmin('second-oid', 'two');
    await addAdmin('third-oid', 'three');

    const middle = await open('admins/1');
    const afterRemove = await post('admins', {
      ...middle.body,
      op: 'remove:admins.users.1',
    }).expect(200);
    expect(afterRemove.text).not.toContain('second-oid');

    await post('admins', { ...formBody(afterRemove.text), intent: 'apply' }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('first-oid');
    expect(yaml).toContain('third-oid');
    expect(yaml).not.toContain('second-oid');
  });

  it('404s a position that is not the next one, and one that is not a number', async () => {
    await request(app.getHttpServer()).get('/-/config/admins/3').set('cookie', ops).expect(404);
    await request(app.getHttpServer())
      .get('/-/config/admins/nobody')
      .set('cookie', ops)
      .expect(404);
    await request(app.getHttpServer()).get('/-/config/admins/0/0').set('cookie', ops).expect(404);
  });
});

describe('refusing a configuration that would not boot', () => {
  it('gives back the loader’s own message, and keeps the edits', async () => {
    const { body } = await open('groups');
    const shapeWithout = String(body['__shape:groups'])
      .split(',')
      .filter((name) => name !== 'platform-ops')
      .join(',');

    const refused = await post('groups', {
      ...body,
      '__shape:groups': shapeWithout,
      intent: 'apply',
    }).expect(400);

    expect(refused.text).toContain('not internally consistent');
    expect(refused.text).toContain('is not defined in the <code>groups</code> map');
    expect(await versionCount()).toBe(1);
  });

  it('answers the magic-link pairing with what to do and where', async () => {
    await addEntry('identity', 'letter', 'magic-link');
    const draft = await open('identity/letter?kind=magic-link');
    const refused = await post('identity/letter?kind=magic-link', {
      ...draft.body,
      intent: 'apply',
    }).expect(400);

    expect(refused.text).toContain('needs the mail transport');
    expect(refused.text).toMatch(/<a href="\/-\/config\/mail[^"]*">[^<]+<\/a>/);
    const json = await post('identity/letter?kind=magic-link', { ...draft.body, intent: 'check' })
      .set('accept', 'application/json')
      .expect(400);
    expect(json.body.problems[0]).toContain('[Mail transport](/-/config/mail)');
  });

  it('refuses a required field left blank', async () => {
    const { body } = await open('identity/entra');
    const refused = await post('identity/entra', {
      ...body,
      'auth.providers.entra.issuer': '',
      intent: 'apply',
    }).expect(400);

    expect(refused.text).toContain('schema validation');
    expect(formBody(refused.text)['auth.providers.entra.issuer']).toBe('');
    expect(await versionCount()).toBe(1);
  });
});

describe('a save that has already happened', () => {
  it('does not append a second version when the page is reloaded', async () => {
    const { body } = await open('branding');
    const posted = await post('branding', {
      ...body,
      'theme.template': 'editorial',
      intent: 'apply',
    }).expect(303);
    expect(await versionCount()).toBe(2);

    await landing('branding', posted);
    await landing('branding', posted);
    expect(await versionCount()).toBe(2);
  });

  it('reports a save from the row rather than from the URL', async () => {
    const invented = await request(app.getHttpServer())
      .get('/-/config/branding?saved=99')
      .set('cookie', ops)
      .expect(200);
    expect(invented.text).not.toContain('spr-toast');

    const nonsense = await request(app.getHttpServer())
      .get('/-/config/branding?saved=not-a-number')
      .set('cookie', ops)
      .expect(200);
    expect(nonsense.text).not.toContain('spr-toast');
  });

  it('keeps answering a JSON caller with the document', async () => {
    const { body } = await open('branding');
    const json = await post('branding', { ...body, 'theme.template': 'editorial', intent: 'apply' })
      .set('accept', 'application/json')
      .expect(200);
    expect(json.body.saved.version).toBe(2);
    expect(json.body.pending).toBe(false);
  });
});

describe('the save bar', () => {
  it('ships the island and the hooks it needs, on a section page and nowhere else', async () => {
    const { html } = await open('branding');
    expect(html).toContain('data-spr-config="branding"');
    expect(html).toMatch(
      /<script type="module" nonce="[^"]+" src="\/-\/static\/config-[^"]+\.js">/,
    );

    expect(html).toContain('value="check"');
    expect(html).toContain('spr-config-save');
    expect(html).not.toContain('disabled>Save');

    const page = await overview().expect(200);
    expect(page.text).not.toContain('/-/static/config-');
  });

  it('opens itself when a round trip left unsaved work on the page', async () => {
    const fresh = await open('groups/engineering/entra');
    expect(fresh.html).not.toContain('data-spr-pending');

    const added = await post('groups/engineering/entra', {
      ...fresh.body,
      op: 'add:groups.engineering.provider.entra',
    }).expect(200);
    expect(added.text).toContain('data-spr-pending');

    const json = await post('branding', { ...(await open('branding')).body, intent: 'apply' })
      .set('accept', 'application/json')
      .expect(200);
    expect(json.body.pending).toBe(false);
  });

  it('tells the unload guard apart from itself, because Add loses nothing', async () => {
    await addEntry('groups', 'client-acme');
    const draft = await open('groups/client-acme');
    expect(draft.html).toContain('data-spr-pending');
    expect(draft.html).not.toContain('data-spr-holds-work');

    const fresh = await open('groups/engineering/entra');
    const added = await post('groups/engineering/entra', {
      ...fresh.body,
      op: 'add:groups.engineering.provider.entra',
    }).expect(200);
    expect(added.text).toContain('data-spr-holds-work');
  });

  it('answers a background check with a verdict and writes nothing', async () => {
    const { body } = await open('branding');
    const json = await post('branding', { ...body, 'theme.template': 'editorial', intent: 'check' })
      .set('accept', 'application/json')
      .expect(200);

    expect(json.body.error).toBeNull();
    expect(json.body.verdict.effect).not.toBe('none');
    expect(await versionCount()).toBe(1);
  });

  it("answers an invalid document with the loader's own message, at 400", async () => {
    const { body } = await open('identity/entra');
    const json = await post('identity/entra', {
      ...body,
      'auth.providers.entra.issuer': '',
      intent: 'check',
    })
      .set('accept', 'application/json')
      .expect(400);

    expect(json.body.error).toContain('schema validation');
    expect(await versionCount()).toBe(1);
  });
});

describe('when the running version is not the newest', () => {
  it('says nothing at all when the save was adopted, because nothing is pending', async () => {
    const { body } = await open('branding');
    const page = await landing(
      'branding',
      await post('branding', {
        ...body,
        'theme.template': 'editorial',
        intent: 'apply',
      }).expect(303),
    );

    expect(page.text).toContain('spr-toast');
    expect(page.text).not.toContain('not yet in force');
    expect(page.text).not.toContain('does not load');
    expect(page.text).not.toContain('waits for a restart');
  });

  // Saves on Semantic retrieval, which is disabled for now
  it.skip('names the keys holding a version back when it cannot be adopted', async () => {
    const { body } = await open('embedding');
    const page = await landing(
      'embedding',
      await post('embedding', {
        ...body,
        'embedding.base_url': 'https://embeddings.example.test/v1',
        'embedding.model': 'text-embedding-3-small',
        'embedding.dimensions': '1536',
        intent: 'apply',
      }).expect(303),
    );

    expect(page.text).toContain('waits for a restart');
    expect(page.text).toContain('embedding');
    expect(page.text).toContain('Every other change in that version waits with');
    expect(page.text).not.toContain('does not load');

    const json = await request(app.getHttpServer())
      .get('/-/config')
      .set('cookie', ops)
      .set('accept', 'application/json')
      .expect(200);
    expect(json.body.running_version).toBe(1);
    expect(json.body.editing_version).toBe(2);
    expect(json.body.waiting_on).toEqual(['embedding']);
  });

  it('says the newest does not load only when boot actually refused it', async () => {
    await appendConfigVersion(harness.tenantId, {
      yaml: 'version: 1\nauth: {}\n',
      resolutionHash: 'x',
      origin: 'admin',
      appliedBy: null,
    });

    const fallen = await bootTestApp(new ConfigService(await loadActiveInstanceConfig()));
    try {
      const page = await request(fallen.getHttpServer())
        .get('/-/config')
        .set('cookie', ops)
        .expect(200);

      expect(page.text).toContain('because the newer one does not load');
      expect(page.text).toContain('Version 2:');
      expect(page.text).toContain('must have required property');
      expect(page.text).not.toContain('saved but not yet in force');
    } finally {
      await fallen.close();
    }
  });
});

describe('a secret stored as a literal', () => {
  it('is not rendered, and is kept when the control is left blank', async () => {
    await storeLiteralSecret();
    const { html, body } = await open('identity/entra');

    expect(html).not.toContain('a-real-secret-value');
    expect(body['auth.providers.entra.client_secret']).toBe('');
    expect(html).toContain('Configured. Type to replace it; blank keeps it.');
    expect(html).toMatch(
      /<input\s+id="f-auth\.providers\.entra\.client_secret"[^>]*type="password"/,
    );
    expect((await overview().expect(200)).text).not.toContain('a-real-secret-value');

    await post('identity/entra', { ...body, intent: 'apply' }).expect(303);
    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toContain(
      'client_secret: a-real-secret-value',
    );
  });

  it('masks a box a secret would be typed into, and only that one', async () => {
    const referenced = await open('identity/entra');
    expect(referenced.body['auth.providers.entra.client_secret']).toBe(
      '${TEST_ENTRA_CLIENT_SECRET}',
    );
    expect(referenced.html).toMatch(
      /<input\s+id="f-auth\.providers\.entra\.client_secret"[^>]*type="text"/,
    );

    await storeLiteralSecret();
    const literal = await open('identity/entra');
    expect(literal.html).toMatch(
      /<input\s+id="f-auth\.providers\.entra\.client_secret"[^>]*type="password"/,
    );
    expect(literal.html).toMatch(
      /<input\s+id="f-auth\.providers\.entra\.client_secret"[^>]*placeholder="•+"/,
    );
    expect(literal.body['auth.providers.entra.client_secret']).toBe('');
    expect(literal.html).not.toContain('data-spr-reveal');
  });

  it('treats every secret the same way, wherever in the schema it is', async () => {
    await storeLiteralMailPassword();
    const { html, body } = await open('mail');

    expect(html).toMatch(/<input\s+id="f-mail\.password"[^>]*type="password"/);
    expect(html).toMatch(/<input\s+id="f-mail\.password"[^>]*placeholder="•+"/);
    expect(html).toContain('Configured. Type to replace it; blank keeps it.');
    expect(html).not.toContain('a-real-mail-password');
    expect(body['mail.password']).toBe('');
  });

  it('keeps a mail password nobody retyped, exactly as it keeps any other', async () => {
    await storeLiteralMailPassword();
    const { body } = await open('mail');
    await post('mail', { ...body, intent: 'apply' }).expect(303);

    expect((await getNewestConfigVersion(harness.tenantId))?.yaml).toContain(
      'password: a-real-mail-password',
    );
  });

  it('leaves the box empty when there is no secret to indicate', async () => {
    const { html } = await open('identity/entra');
    const box = /<input\s+id="f-auth\.providers\.entra\.client_id"[^>]*>/.exec(html)?.[0] ?? '';
    expect(box).not.toContain('•');
  });

  it('is replaced when something is typed into it', async () => {
    await storeLiteralSecret();
    const { body } = await open('identity/entra');
    await post('identity/entra', {
      ...body,
      'auth.providers.entra.client_secret': '${TEST_ENTRA_CLIENT_SECRET}',
      intent: 'apply',
    }).expect(303);

    const yaml = (await getNewestConfigVersion(harness.tenantId))?.yaml ?? '';
    expect(yaml).toContain('client_secret: ${TEST_ENTRA_CLIENT_SECRET}');
    expect(yaml).not.toContain('a-real-secret-value');
  });
});

describe('when the file is authoritative', () => {
  it('says so on the overview', async () => {
    useFileMode();
    const page = await overview().expect(200);
    expect(page.text).toContain('The file is authoritative');
    expect(page.text).toContain('the settings are read-only here');
  });

  it('renders the settings read-only, so a browser submits nothing', async () => {
    useFileMode();
    const page = await request(app.getHttpServer())
      .get('/-/config/identity/entra')
      .set('cookie', ops)
      .expect(200);

    expect(page.text).toContain('https://login.example.test/v2.0');
    expect(page.text).toContain('which is authoritative');
    expect(Object.keys(formBody(page.text))).toEqual([]);
  });

  it('refuses a write anyway, rather than ignoring it', async () => {
    useFileMode();
    const before = await versionCount();
    const page = await request(app.getHttpServer())
      .post('/-/config/reading')
      .set('cookie', ops)
      .send({ 'theme.template': 'editorial', intent: 'apply' })
      .expect(409);

    expect(page.text).toContain('file-authoritative');
    expect(await versionCount()).toBe(before);
  });
});

describe('the environment page', () => {
  const environment = () =>
    request(app.getHttpServer()).get('/-/config/environment').set('cookie', ops);

  const environmentJson = () => environment().set('accept', 'application/json');

  it('names every variable this process reads, set or not', async () => {
    const html = (await environment().expect(200)).text;
    expect(html).toContain('SPEICHER_MIRROR_ROOT');
    expect(html).toContain('SPEICHER_SYNC_CONCURRENCY');
    expect(html).toContain('SPEICHER_DATABASE_URL');
  });

  it('is not on the settings index any more', async () => {
    const html = (await overview().expect(200)).text;
    expect(html).not.toContain('SPEICHER_MIRROR_ROOT');
    expect(html).toContain('/-/config/environment');

    const json = await request(app.getHttpServer())
      .get('/-/config')
      .set('cookie', ops)
      .set('accept', 'application/json')
      .expect(200);
    expect(json.body.environment).toBeUndefined();
  });

  it('names the two processes rather than saying "both"', async () => {
    const html = (await environment().expect(200)).text;
    expect(html).toContain('web + worker');
    expect(html).not.toMatch(/<td>\s*both\s*<\/td>/);

    const rows = (await environmentJson().expect(200)).body.environment as {
      name: string;
      readBy: string;
    }[];
    expect(rows.find((r) => r.name === 'SPEICHER_DATABASE_URL')?.readBy).toBe('both');
  });

  it('never prints a secret, in either representation', async () => {
    const url = process.env.SPEICHER_DATABASE_URL as string;
    const html = (await environment().expect(200)).text;
    expect(html).not.toContain(url);

    const json = await environmentJson().expect(200);
    const row = (
      json.body.environment as { name: string; value: string | null; secret: boolean }[]
    ).find((r) => r.name === 'SPEICHER_DATABASE_URL');
    expect(row).toMatchObject({ value: null, secret: true });
    expect(JSON.stringify(json.body)).not.toContain(url);
  });

  it('distinguishes a value that was set from one that defaulted', async () => {
    const json = await environmentJson().expect(200);
    const rows = json.body.environment as { name: string; origin: string }[];
    expect(rows.find((r) => r.name === 'SPEICHER_LOG_LEVEL')?.origin).toBe('environment');
    expect(rows.find((r) => r.name === 'SPEICHER_TRUST_PROXY')?.origin).toBe('default');
  });
});
