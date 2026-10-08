import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DASHBOARD_SECTIONS } from '../../src/dashboard/dashboard-sections';
import { loadDocument } from '../../src/dashboard/configurator/config-form/document';
import {
  CONFIG_SECTIONS,
  Field,
  allFields,
  buildSections,
} from '../../src/dashboard/configurator/config-form/fields';
import { MAX_HITS, dashboardIndex, searchDashboard } from '../../src/dashboard/search/search';
import { SEARCHABLE_VALUES, SEARCH_KEYWORDS } from '../../src/dashboard/search/search-keywords';

const FULL = readFileSync(join(__dirname, '../fixtures/instance-full.yaml'), 'utf8');

const sectionsOf = (yaml: string) => buildSections(loadDocument(yaml));
const SECTIONS = sectionsOf(FULL);

const EVERYTHING = { showSetup: false, hasContent: true };

const find = (query: string, yaml = FULL) =>
  searchDashboard(query, sectionsOf(yaml), EVERYTHING).hits;

const hrefs = (query: string) => find(query).map((hit) => hit.href);

const pages = (query: string) => find(query).map((hit) => hit.href.split('#')[0]);

function everySchemaPath(): Set<string> {
  return new Set(everyField().map((f: Field) => f.schemaPath));
}

function everyField(): Field[] {
  const azure = (auth: string) =>
    FULL.replace('driver: filesystem', `driver: azure\n  auth: ${auth}`);
  return [
    FULL,
    FULL.replace('driver: filesystem', 'driver: s3'),
    FULL.replace('driver: filesystem', 'driver: azure'),
    azure('key'),
    azure('connection_string'),
    azure('workload_identity'),
  ].flatMap((yaml) => allFields(sectionsOf(yaml)));
}

describe('the search vocabulary', () => {
  it('gives every page in the column a word that is not its own name', () => {
    const missing = DASHBOARD_SECTIONS.filter(
      (section) => (SEARCH_KEYWORDS[`page:${section.id}`] ?? '').trim() === '',
    ).map((section) => section.id);
    expect(missing).toEqual([]);
  });

  it('gives every settings section one, children included', () => {
    const missing = CONFIG_SECTIONS.filter(
      (section) => (SEARCH_KEYWORDS[`section:${section.id}`] ?? '').trim() === '',
    ).map((section) => section.id);
    expect(missing).toEqual([]);
  });

  it('has no word for a page or section that is gone', () => {
    const known = new Set([
      ...DASHBOARD_SECTIONS.map((section) => `page:${section.id}`),
      ...CONFIG_SECTIONS.map((section) => `section:${section.id}`),
    ]);
    const dead = Object.keys(SEARCH_KEYWORDS).filter(
      (key) => !key.startsWith('field:') && !known.has(key),
    );
    expect(dead).toEqual([]);
  });

  it('has no word for a control the form no longer renders', () => {
    const rendered = everySchemaPath();
    expect(rendered.size).toBeGreaterThan(50);

    const dead = Object.keys(SEARCH_KEYWORDS)
      .filter((key) => key.startsWith('field:'))
      .map((key) => key.slice('field:'.length))
      .filter((path) => !rendered.has(path));
    expect(dead).toEqual([]);
  });

  it('is written in words the form does not already use', () => {
    expect(SEARCH_KEYWORDS['section:identity']).toContain('sso');
    expect(SEARCH_KEYWORDS['section:storage']).toContain('s3');
    expect(SEARCH_KEYWORDS['section:embedding']).toContain('rag');
    for (const section of CONFIG_SECTIONS) {
      const words = SEARCH_KEYWORDS[`section:${section.id}`];
      expect(words.toLowerCase()).not.toBe(section.title.toLowerCase());
    }
  });
});

describe('the values a query may match on', () => {
  it('names only controls the form renders', () => {
    const rendered = everySchemaPath();
    expect(rendered.size).toBeGreaterThan(50);
    expect(SEARCHABLE_VALUES.filter((path) => !rendered.has(path))).toEqual([]);
  });

  it('names no control that is a secret in any shape the form takes', () => {
    const unsafe = everyField()
      .filter((field: Field) => field.kind === 'secret' || field.kind === 'file')
      .map((field: Field) => field.schemaPath)
      .filter((path) => SEARCHABLE_VALUES.includes(path));
    expect([...new Set(unsafe)]).toEqual([]);

    const secrets = everyField().filter((f: Field) => f.kind === 'secret');
    expect(secrets.length).toBeGreaterThan(5);
  });

  it('leaves out the field a credential is pasted into, though nothing calls it secret', () => {
    for (const path of [
      'forges.<key>.repos.<index>.url',
      'forges.<key>.repos.<index>.username',
      'mail.username',
      'assets.access_key_id',
    ]) {
      expect(SEARCHABLE_VALUES).not.toContain(path);
    }
  });
});

describe('what a query finds', () => {
  it('reaches a page by a word that is nowhere on it', () => {
    expect(hrefs('sso')).toContain('/-/config/identity');
    expect(hrefs('s3')).toContain('/-/config/storage');
    expect(hrefs('why can nobody see')).toEqual([]);
    expect(hrefs('denied')).toContain('/-/explain');
  });

  it('reaches a control, at the control', () => {
    const hit = find('smtp host').find((h) => h.kind === 'setting');
    expect(hit?.href).toBe('/-/config/mail#f-mail.host');
    expect(hit?.context).toBe('Configuration › Mail transport');
  });

  it('deep-links to a fragment the form actually renders', () => {
    const paths = new Set(allFields(SECTIONS).map((field: Field) => `f-${field.path}`));
    const fragments = find('password')
      .filter((hit) => hit.kind === 'setting')
      .map((hit) => hit.href.split('#')[1]);

    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.filter((fragment) => !paths.has(fragment))).toEqual([]);
  });

  it('finds this instance’s own configuration by what its rows say', () => {
    expect(hrefs('platform-ops')).toContain('/-/config/groups/platform-ops');
    expect(hrefs('grp-eng')).toContain('/-/config/groups/engineering');
  });

  it('narrows on every word rather than widening', () => {
    const one = find('mail').length;
    const two = find('mail transport').length;
    expect(two).toBeGreaterThan(0);
    expect(two).toBeLessThan(one);
  });

  it('puts the row the words name above the row that merely mentions them', () => {
    const hrefs = find('reads').map((hit) => hit.href);
    const byKeyword = hrefs.indexOf('/-/analytics');
    const byExplanation = hrefs.indexOf('/-/config/notifications#f-notify.stale_after');

    expect(hrefs[0]).toBe('/-/config/analytics#f-analytics.enabled');
    expect(byKeyword).toBeGreaterThan(0);
    expect(byExplanation).toBeGreaterThan(0);
    expect(byKeyword).toBeLessThan(byExplanation);
  });

  it('finds a repository by what the forge calls it, which is on no page as a row', () => {
    expect(pages('runbooks')).toContain('/-/config/sources/onprem');
    expect(pages('playbooks')).toContain('/-/config/sources/onprem');
    expect(find('playbooks').some((hit) => hit.href.endsWith('#f-forges.onprem.repos.1.id'))).toBe(
      true,
    );
  });

  it('finds a provider by the issuer an app registration shows', () => {
    expect(pages('login.example.test')).toContain('/-/config/identity/entra');
  });

  it('matches a value without ever drawing one', () => {
    const hit = find('runbooks').find((h) => h.href.startsWith('/-/config/sources/onprem#'));
    expect(hit).toBeDefined();
    expect(`${hit?.title} ${hit?.context} ${hit?.help}`).not.toContain('runbooks');
  });

  it('ranks a value match below the row the word names', () => {
    const hits = find('docs');
    const byName = hits.findIndex((hit) => hit.title.toLowerCase().includes('docs'));
    const byValue = hits.findIndex((hit) => hit.href === '/-/config/mail#f-mail.from');
    expect(byValue).toBeGreaterThan(0);
    expect(byName).toBeLessThan(byValue);
  });

  it('answers an empty query with nothing, rather than with everything', () => {
    expect(find('')).toEqual([]);
    expect(find('   ')).toEqual([]);
  });

  it('says how many it found when it shows fewer', () => {
    const many = searchDashboard('e', SECTIONS, EVERYTHING);
    expect(many.total).toBeGreaterThan(MAX_HITS);
    expect(many.hits).toHaveLength(MAX_HITS);
  });

  it('offers one row per control per page, not one per box', () => {
    const rows = find('provider group id').filter(
      (hit) => hit.title === 'Provider group id' && hit.href.startsWith('/-/config/groups/'),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((hit) => hit.href.split('#')[0])).size).toBe(rows.length);
  });
});

describe('what the corpus never carries', () => {
  const LITERAL = 'hunter2-literal-secret';
  const withSecret = FULL.replace(/\$\{TEST_ENTRA_CLIENT_SECRET\}/g, LITERAL);

  it('carries no secret, anywhere in anything it matches on', () => {
    const rows = dashboardIndex(sectionsOf(withSecret), EVERYTHING);
    const searchable = rows.map((row) => `${row.name} ${row.words} ${row.body}`).join('\n');
    const shown = rows
      .map((row) => `${row.hit.title} ${row.hit.context} ${row.hit.help}`)
      .join('\n');

    expect(searchable).not.toContain(LITERAL);
    expect(shown).not.toContain(LITERAL);
    expect(searchable).toContain('client secret');
    expect(searchable).toContain('auth.providers.entra.client_secret');
  });

  it('carries no value that is not on the list', () => {
    const rows = dashboardIndex(SECTIONS, EVERYTHING).filter((row) => row.hit.kind !== 'member');
    const searchable = rows.map((row) => `${row.name} ${row.words} ${row.body}`).join('\n');

    expect(FULL).toContain('url: https://example.test/internal/playbooks.git');
    expect(searchable).not.toContain('playbooks.git');
    expect(searchable).toContain('playbooks');
  });

  it('offers no page the column would not draw', () => {
    const bare = searchDashboard('graph', SECTIONS, { hasContent: false });
    expect(bare.hits.map((hit) => hit.href)).not.toContain('/-/graph');
    expect(searchDashboard('graph', SECTIONS, EVERYTHING).hits.map((h) => h.href)).toContain(
      '/-/graph',
    );
  });

  it('still finds the pages when the stored document does not parse', () => {
    const broken = searchDashboard('smtp', null, EVERYTHING);
    expect(broken.hits.map((hit) => hit.href)).toContain('/-/config/mail');
    expect(broken.hits.filter((hit) => hit.kind === 'setting')).toEqual([]);
  });
});
