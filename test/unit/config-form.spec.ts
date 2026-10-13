import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Document } from 'yaml';
import { readStylesheet } from '../helpers/stylesheet';

import { GITHUB_CALLBACK_PATH } from '../../src/auth/callback-url';
import { ELIDED, REDACTED, displayYaml } from '../../src/dashboard/configurator/config-form/redact';
import { applyForm } from '../../src/dashboard/configurator/config-form/apply';
import { renameMember } from '../../src/dashboard/configurator/config-form/member-edits';
import { sectionOf } from '../../src/dashboard/configurator/config-form/sections';
import { repoCard } from '../../src/dashboard/configurator/config-form/sections/content-sources/git-repository-card';
import { SCP_FORM, repositoryName, sshRemoteUrl } from '../../src/forge/remote-url';
import {
  RENDERED_PREFIX,
  SHAPE_PREFIX,
  addTarget,
  collectionsOf,
  reshaped,
  shapeControls,
} from '../../src/dashboard/configurator/config-form/collections';
import {
  appendSeqItem,
  loadDocument,
  serialise,
  setNodeAt,
} from '../../src/dashboard/configurator/config-form/document';
import {
  CONFIG_NAV_SECTIONS,
  CONFIG_SECTIONS,
  Card,
  Field,
  SectionEntry,
  ChoiceItem,
  CopyValueItem,
  allFields,
  allOps,
  buildSections,
  cardItems,
  entraIssuerFor,
  fieldsOf,
  freeMemberId,
  isConfigSection,
  isConfigSubsection,
  seedProvider,
  withHttpsScheme,
} from '../../src/dashboard/configurator/config-form/fields';
import type {
  FieldKind,
  FieldOf,
} from '../../src/dashboard/configurator/config-form/config-fields';
import { renderHelp } from '../../src/global-ui/help-markup';
import { isKnownTimeZone } from '../../src/dashboard/analytics/buckets';
import { PALETTE_KEYS } from '../../src/config/palette';
import { loadInstanceConfig } from '../../src/config/parser';

const SCHEMA = JSON.parse(
  readFileSync(join(__dirname, '../../src/config/schema/instance.schema.json'), 'utf8'),
) as Record<string, any>;

const FULL = readFileSync(join(__dirname, '../fixtures/instance-full.yaml'), 'utf8');

// The pre-signing fields are only drawn for a store that can hand out a URL, so a
// duration in the storage section needs a document whose driver is one of those
const FULL_PRESIGNING = FULL.replace(
  'driver: filesystem\n  path: ./var/assets',
  'driver: s3\n  bucket: acmedocs\n  region: eu-central-1',
);

function fieldsFor(yaml: string): Field[] {
  return allFields(buildSections(loadDocument(yaml)));
}

// Checks that `field` is of `kind`, and gives it that kind's type
function ofKind<K extends FieldKind>(field: Field | undefined, kind: K): FieldOf<K> {
  expect(field?.kind).toBe(kind);
  return field as FieldOf<K>;
}

// What the browser sends for a field left as the page drew it; undefined where it sends nothing
function rendered(field: Field): string | string[] | undefined {
  if (field.kind === 'boolean' || field.kind === 'membership') {
    return field.checked ? 'on' : undefined;
  }
  if (field.kind === 'checkboxes') return field.values;
  if (field.kind === 'file') return undefined;
  return field.value;
}

// The same for every field, as the body of a save nobody changed anything on
function untouchedBody(fields: Field[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    const value = rendered(field);
    if (value !== undefined) body[field.path] = value;
    if (field.kind === 'duration' || field.kind === 'bytes') {
      if (field.unit) body[`unit:${field.path}`] = field.unit;
    }
  }
  return body;
}

function applyAll(doc: Document, body: Record<string, unknown>) {
  let structural = false;
  let changed = false;
  for (const entry of CONFIG_SECTIONS) {
    const result = applyForm(doc, body, entry.id);
    structural = structural || result.structural;
    changed = changed || result.changed;
  }
  return { structural, changed };
}

function everyRenderedSchemaPath(): Set<string> {
  const azure = (auth: string) =>
    FULL.replace('driver: filesystem', `driver: azure\n  auth: ${auth}`);
  const variants = [
    FULL,
    FULL.replace('driver: filesystem', 'driver: s3'),
    FULL.replace('driver: filesystem', 'driver: azure'),
    azure('key'),
    azure('connection_string'),
    azure('workload_identity'),
  ];
  return new Set(variants.flatMap((yaml) => fieldsFor(yaml).map((f) => f.schemaPath)));
}

function schemaLeaves(): string[] {
  const out = new Set<string>();
  const defs = SCHEMA.$defs as Record<string, any>;

  const resolve = (node: any): any =>
    node?.$ref ? defs[String(node.$ref).replace('#/$defs/', '')] : node;

  const walk = (node: any, path: string, seen: Set<any>): void => {
    node = resolve(node);
    if (!node || seen.has(node)) return;

    for (const branch of node.oneOf ?? node.anyOf ?? []) walk(branch, path, new Set(seen));

    if (node.type === 'array' || node.items) {
      const items = resolve(node.items);
      if (items?.type === 'object' || items?.properties) {
        walk(items, `${path}.<index>`, new Set([...seen, node]));
        return;
      }
      out.add(path);
      return;
    }

    if (node.properties) {
      for (const [key, child] of Object.entries(node.properties)) {
        walk(child, path === '' ? key : `${path}.${key}`, new Set([...seen, node]));
      }
      return;
    }

    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      walk(node.additionalProperties, `${path}.<key>`, new Set([...seen, node]));
      return;
    }

    const holdsAValue =
      node.enum !== undefined ||
      node.const !== undefined ||
      Array.isArray(node.type) ||
      (typeof node.type === 'string' && node.type !== 'object' && node.type !== 'array');
    if (holdsAValue) out.add(path);
  };

  walk(SCHEMA, '', new Set());
  return [...out].sort();
}

function requiredSchemaPaths(): Set<string> {
  const out = new Set<string>();
  const defs = SCHEMA.$defs as Record<string, any>;
  const resolve = (node: any): any =>
    node?.$ref ? defs[String(node.$ref).replace('#/$defs/', '')] : node;

  const walk = (node: any, path: string, seen: Set<any>): void => {
    node = resolve(node);
    if (!node || seen.has(node)) return;
    const next = new Set([...seen, node]);

    for (const key of (node.required as string[] | undefined) ?? []) {
      out.add(path === '' ? key : `${path}.${key}`);
    }
    for (const branch of [
      ...(node.allOf ?? []),
      ...(node.anyOf ?? []),
      ...(node.oneOf ?? []),
      node.then,
      node.else,
    ]) {
      if (branch) walk(branch, path, new Set(next));
    }
    if (node.items) walk(node.items, `${path}.<index>`, new Set(next));
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      walk(child, path === '' ? key : `${path}.${key}`, new Set(next));
    }
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      walk(node.additionalProperties, `${path}.<key>`, new Set(next));
    }
  };

  walk(SCHEMA, '', new Set());
  return out;
}

describe('advanced settings', () => {
  it('never folds away a setting the loader requires', () => {
    const required = requiredSchemaPaths();
    const folded = fieldsFor(FULL).filter((f) => f.advanced);
    expect(folded.filter((f) => required.has(f.schemaPath)).map((f) => f.path)).toEqual([]);
    expect(required.has('forges.<key>.private_key')).toBe(true);
  });

  it('never folds away a control that decides which controls exist', () => {
    const folded = fieldsFor(FULL).filter((f) => f.advanced);
    expect(folded.filter((f) => f.kind === 'select' && f.reshapes).map((f) => f.path)).toEqual([]);
  });

  it('marks nothing inside a card, where the block does not reach', () => {
    const inCards: string[] = [];
    const walk = (card: Card): void => {
      for (const field of fieldsOf(card.items)) if (field.advanced) inCards.push(field.path);
      card.cards.forEach(walk);
    };
    for (const section of buildSections(loadDocument(FULL))) section.cards.forEach(walk);
    expect(inCards).toEqual([]);
  });

  it('is a rendering and not a second list, so decoding still reaches it', () => {
    const paths = fieldsFor(FULL).map((f) => f.path);
    expect(paths).toContain('forges.gh.base_url');
    expect(paths).toContain('auth.providers.hub.base_url');
  });
});

describe('a source’s default repository owner', () => {
  it('is a text box on every kind of source', () => {
    for (const id of ['gh', 'onprem']) {
      const owner = fieldsFor(FULL).find((f) => f.path === `forges.${id}.default_repository_owner`);
      expect(owner?.kind).toBe('text');
      expect(owner?.schemaPath).toBe('forges.<key>.default_repository_owner');
    }
  });
});

describe('a width asked for from a model', () => {
  it('names a control the same page renders', () => {
    const dangling: string[] = [];
    for (const section of buildSections(loadDocument(FULL))) {
      const own = new Set(allFields([section]).map((f) => f.path));
      for (const field of allFields([section])) {
        if (field.kind === 'embedding-model' && !own.has(field.dimensionsPath)) {
          dangling.push(`${field.path} -> ${field.dimensionsPath}`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  it('is on the model, where the answer is asked for', () => {
    const fields = fieldsFor(FULL);
    const model = ofKind(
      fields.find((f) => f.path === 'embedding.model'),
      'embedding-model',
    );
    expect(model.dimensionsPath).toBe('embedding.dimensions');
    expect(fields.filter((f) => f.kind === 'embedding-model').map((f) => f.path)).toEqual([
      'embedding.model',
    ]);
  });
});

const OMITTED_FROM_FORM: Record<string, string> = {
  'auth.providers.<key>.type':
    "a provider's kind is chosen when it is added and is not a setting " +
    'afterwards — changing it would keep the id, and every grant written against ' +
    'it, while discarding every field belonging to the shape it was. Removing the ' +
    'provider and adding one is the same operation with nothing hidden in it',
  version:
    'a schema version marker with one legal value; an operator changing it is ' +
    'describing a migration that has not happened',
  'forges.<key>.type':
    "a source's kind is chosen when it is added and is not a setting afterwards, " +
    "for the reason a provider's is not: changing it would keep the id — which is " +
    'a URL segment and the key of a materialised row — while discarding every ' +
    'field belonging to the shape it was, and would orphan the repositories of a ' +
    '`git` source in the process',
  'forges.<key>.token':
    'a whole-forge token applies to no driver that is built — `git` repositories ' +
    'carry their own, and that is where the form offers it',
};

describe('coverage of the schema', () => {
  it('offers a control for every setting, or says why not', () => {
    const rendered = everyRenderedSchemaPath();
    const missing = schemaLeaves().filter(
      (leaf) => !rendered.has(leaf) && !(leaf in OMITTED_FROM_FORM),
    );

    expect(missing).toEqual([]);
  });

  it('does not carry a reason for a key it renders anyway', () => {
    const rendered = everyRenderedSchemaPath();
    expect(Object.keys(OMITTED_FROM_FORM).filter((k) => rendered.has(k))).toEqual([]);
  });

  it('names every omission against a key the schema actually has', () => {
    const leaves = new Set(schemaLeaves());
    expect(Object.keys(OMITTED_FROM_FORM).filter((k) => !leaves.has(k))).toEqual([]);
  });

  it('keeps every logo however long the list is', () => {
    const doc = loadDocument(FULL);
    for (let n = 0; n < 12; n += 1) {
      setNodeAt(doc, ['auth', 'providers', `spare-${n}`], {
        type: 'oidc',
        issuer: 'https://login.example.test/v2.0',
        client_id: 'spare',
      });
    }

    const add = buildSections(doc).find((section) => section.id === 'groups/engineering')!
      .addOps[0];
    expect(add.nameOptions!.length).toBeGreaterThan(12);
    expect(add.nameOptions!.every((option) => option.mark !== '')).toBe(true);
  });

  it('renders all three provider shapes and both forge shapes', () => {
    const paths = fieldsFor(FULL).map((f) => f.path);
    expect(paths).toContain('auth.providers.entra.issuer');
    expect(paths).toContain('auth.providers.letter.token_ttl');
    expect(paths).toContain('auth.providers.hub.base_url');
    expect(paths).toContain('forges.gh.app_id');
    expect(paths).toContain('forges.onprem.repos.0.deploy_key');
    expect(paths).toContain('forges.onprem.repos.1.token');
  });
});

describe('the shape the form was rendered with', () => {
  it('describes every collection the form can grow', () => {
    const doc = loadDocument(FULL);
    const described = new Set(collectionsOf(doc).map((c) => c.path));
    const growable = allOps(buildSections(doc))
      .filter((op) => op.startsWith('add:'))
      .map((op) => addTarget(op).path);

    expect(growable.filter((path) => !described.has(path))).toEqual([]);
  });

  it('carries what a shape-deciding control was showing, so a move can be told from a stay', () => {
    const doc = loadDocument(FULL);
    const storage = sectionOf(doc, 'storage')!;
    const control = shapeControls(doc, storage).find(
      (each) => each.name === `${RENDERED_PREFIX}assets.driver`,
    );
    expect(control?.value).toBe('filesystem');

    const body: Record<string, unknown> = Object.fromEntries(
      shapeControls(doc, storage).map((each) => [each.name, each.value]),
    );
    expect(reshaped(storage, body)).toBe(false);

    const moved = loadDocument(FULL.replace('driver: filesystem', 'driver: azure'));
    expect(reshaped(sectionOf(moved, 'storage')!, body)).toBe(true);
  });

  it('sees an entry added in this process, not only ones parsed from the file', () => {
    const doc = loadDocument(FULL);
    applyForm(doc, { 'newname:auth.providers': 'okta', op: 'add:auth.providers' }, 'identity');

    const providers = collectionsOf(doc).find((c) => c.path === 'auth.providers');
    expect(providers?.keys).toContain('okta');
  });
});

describe('one section at a time', () => {
  it('names the same sections the form builds, in the same order', () => {
    const built = buildSections(loadDocument(FULL));
    expect(
      built
        .filter((section) => section.parent === null)
        .map((section) => [section.id, section.title]),
    ).toEqual(CONFIG_NAV_SECTIONS.map((entry) => [entry.id, entry.title]));

    expect(CONFIG_NAV_SECTIONS.every((entry) => entry.parent === undefined)).toBe(true);
    expect(CONFIG_SECTIONS.length).toBeGreaterThan(CONFIG_NAV_SECTIONS.length);
  });

  it('splits the relay from who is told over it, one block per page', () => {
    const built = buildSections(loadDocument(FULL));
    const mail = built.find((section) => section.id === 'mail')!;
    const notifications = built.find((section) => section.id === 'notifications')!;

    for (const section of [mail, notifications]) {
      expect(section.parent).toBeNull();
      expect(isConfigSection(section.id)).toBe(true);
      expect(isConfigSubsection(section.id)).toBe(false);
      expect(section.entries).toEqual([]);
      expect(section.addOps).toEqual([]);
    }

    expect(allFields([mail]).map((f) => f.schemaPath)).toEqual([
      'mail.host',
      'mail.port',
      'mail.username',
      'mail.password',
      'mail.from',
      'mail.reply_to',
    ]);
    expect(notifications.fields).toEqual([]);
    expect(
      notifications.cards.map((card) => fieldsOf(card.items).map((f) => f.schemaPath)),
    ).toEqual([
      ['notify.sync_failure'],
      ['notify.stale', 'notify.stale_after'],
      ['notify.grant_expiry', 'notify.expiry_warning'],
    ]);
    expect(allFields([mail]).every((f) => f.schemaPath.startsWith('mail.'))).toBe(true);
    expect(allFields([notifications]).every((f) => f.schemaPath.startsWith('notify.'))).toBe(true);
  });

  it('groups the link graph by the surface each setting decides', () => {
    const reading = buildSections(loadDocument(FULL)).find((s) => s.id === 'reading')!;

    expect(reading.fields.map((f) => f.schemaPath)).toEqual(['graph.enabled']);
    expect(reading.cards.map((card) => fieldsOf(card.items).map((f) => f.schemaPath))).toEqual([
      ['graph.related', 'graph.related_limit'],
      ['graph.previews', 'graph.terms'],
      ['graph.search_boost'],
    ]);

    expect(reading.cards.every((card) => !card.titleIsKey)).toBe(true);
    expect(reading.cards.every((card) => card.subtitle !== '')).toBe(true);

    const limit = allFields([reading]).find((f) => f.schemaPath === 'graph.related_limit')!;
    expect(limit.shownWith).toBe('graph.related');

    expect(reading.cards.every((card) => card.shownWith === 'graph.enabled')).toBe(true);
    expect(reading.fields[0].shownWith).toBeUndefined();
  });

  it('sets a card\u2019s heading in the key face only where the heading is one', () => {
    const cards: Card[] = [];
    const walk = (card: Card) => {
      cards.push(card);
      card.cards.forEach(walk);
    };
    buildSections(loadDocument(FULL)).forEach((section) => section.cards.forEach(walk));

    expect(cards.length).toBeGreaterThan(5);
    expect(
      cards
        .filter((card) => card.titleIsKey)
        .map((card) => card.title)
        .sort(),
    ).toEqual(['playbooks', 'runbooks']);
  });

  it('reveals the checked row rather than a face per option, so no list is too long', () => {
    const admin = readStylesheet(join(__dirname, '../../src/dashboard/ui/dashboard.css'));
    expect(admin).not.toMatch(/\.spr-dropdown[^{]*nth-of-type/);
    expect(admin).toContain('.spr-dd-row:not(:has(> input:checked))');
    expect(admin).toContain('.spr-dropdown:not([open])::details-content');

    const marked = buildSections(loadDocument(FULL))
      .flatMap((section) => section.addOps)
      .flatMap((op) => [op.typeOptions, op.nameOptions ?? []])
      .filter((options) => options.some((option) => option.mark));
    expect(marked.length).toBeGreaterThan(0);
    for (const options of marked) {
      expect(options.filter((option) => option.mark)).toHaveLength(options.length);
    }
  });

  it('titles a tile from the page it opens, and draws its icon', () => {
    const built = buildSections(loadDocument(FULL));
    const index = built.find((section) => section.id === 'branding')!;

    expect(index.entries.length).toBeGreaterThan(0);
    for (const entry of index.entries) {
      const id = entry.href.replace('/-/config/', '');
      const page = built.find((section) => section.id === id)!;
      expect(entry.title).toBe(page.title);
      expect(entry.subtitle).toBe(page.blurb);
      expect(entry.subtitleIsProse).toBe(true);
      expect(entry.icon).toBe(CONFIG_SECTIONS.find((s) => s.id === id)!.icon);
      expect(entry.mark).toBe('');
      expect(entry.removeOp).toBeNull();
    }
  });

  it("shows a member tile's subtitle as it is, never as prose", () => {
    const built = buildSections(loadDocument(FULL));
    const members = built.filter((section) => section.entriesArePages !== true);
    const entries = members.flatMap((section) => section.entries);

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.subtitleIsProse).toBeUndefined();
  });

  it('builds a page for every provider, and a tile on the index for each', () => {
    const built = buildSections(loadDocument(FULL));
    const index = built.find((section) => section.id === 'identity')!;
    const pages = built.filter((section) => section.parent === 'identity');

    expect(pages.length).toBeGreaterThan(1);
    expect(index.entries.map((entry) => entry.href).sort()).toEqual(
      pages.map((page) => `/-/config/${page.id}`).sort(),
    );
    expect(allFields([index])).toEqual([]);
    expect(allFields(pages).map((f) => f.path)).toContain('auth.default_provider');
  });

  it("leaves another section's switches alone", () => {
    const doc = loadDocument(FULL);
    expect(serialise(doc)).toMatch(/enabled: true/);

    applyForm(doc, { 'auth.providers.entra.subject_claim': 'sub' }, 'identity/entra');

    const out = serialise(doc);
    expect(out).toContain('subject_claim: sub');
    expect(out).toMatch(/enabled: true/);
  });

  it('writes nothing for a field belonging to another section', () => {
    const doc = loadDocument(FULL);
    applyForm(doc, { 'theme.template': 'editorial' }, 'identity');
    expect(serialise(doc)).not.toContain('template: editorial');
  });

  it('carries the shape of its own collections and no others', () => {
    const doc = loadDocument(FULL);
    const sections = buildSections(doc);
    const named = (id: string) =>
      shapeControls(doc, sections.find((section) => section.id === id)!).map((control) =>
        control.name.replace('__shape:', ''),
      );

    expect(named('identity')).toEqual(['auth.providers']);
    expect(named('groups')).toEqual(['groups']);
    expect(named('admins')).toEqual(['admins.users']);
    expect(named('groups/engineering')).toEqual(['groups.engineering']);
    expect(named('groups')).not.toContain('auth.providers');
    expect(named('reading')).toEqual([]);
  });

  it('ignores a shape control for a collection this section did not render', () => {
    const doc = loadDocument(FULL);
    applyForm(doc, { '__shape:groups': '' }, 'identity');
    expect(serialise(doc)).toContain('engineering:');
  });

  it('writes one provider from its own page, and never another', () => {
    const doc = loadDocument(FULL);
    applyForm(
      doc,
      {
        'auth.providers.entra.subject_claim': 'sub',
        'auth.providers.letter.token_ttl': '99m',
      },
      'identity/entra',
    );
    const out = serialise(doc);
    expect(out).toContain('subject_claim: sub');
    expect(out).not.toContain('99m');
  });

  it('cannot remove a provider from a provider page, whatever it submits', () => {
    const doc = loadDocument(FULL);
    applyForm(doc, { '__shape:auth.providers': 'entra' }, 'identity/entra');
    expect(serialise(doc)).toContain('letter:');
  });

  it('creates nothing for a provider the document does not have', () => {
    const doc = loadDocument(FULL);
    applyForm(
      doc,
      {
        'auth.providers.okta.type': 'oidc',
        'auth.providers.okta.issuer': 'https://okta.example.test',
      },
      'identity/okta',
    );
    expect(serialise(doc)).not.toContain('okta:');
  });

  it('ignores a structural operation another section offers', () => {
    const doc = loadDocument(FULL);
    applyForm(doc, { op: 'add:admins.users' }, 'identity');
    const users = collectionsOf(doc).find((c) => c.path === 'admins.users');
    expect(users?.length).toBe(
      collectionsOf(loadDocument(FULL)).find((c) => c.path === 'admins.users')?.length,
    );
  });
});

describe('the Entra kind', () => {
  const entra = (yaml: string) =>
    buildSections(loadDocument(yaml)).find((section) => section.parent === 'identity');

  const WITH_ENTRA = FULL.replace(
    'issuer: https://login.example.test/v2.0',
    `issuer: ${entraIssuerFor('a-tenant-guid')}`,
  );

  it('seeds the claims Entra emits, because the schema defaults are the generic ones', () => {
    expect(seedProvider('entra')).toEqual({
      type: 'oidc',
      subject_claim: 'oid',
      groups_claim: 'groups',
      email_claim: 'preferred_username',
    });
    expect(seedProvider('oidc')).toEqual({ type: 'oidc' });
    expect(seedProvider('ldap')).toEqual({});
  });

  it('asks for the tenant and stores the issuer, in both directions', () => {
    const section = entra(WITH_ENTRA)!;
    const tenant = allFields([section]).find((f) => f.kind === 'entra-tenant');
    expect(tenant).toBeDefined();
    expect(tenant!.path).toBe('auth.providers.entra.issuer');
    expect(tenant!.value).toBe('a-tenant-guid');

    const doc = loadDocument(WITH_ENTRA);
    applyForm(doc, { 'auth.providers.entra.issuer': 'another-tenant' }, section.id);
    expect(serialise(doc)).toContain(entraIssuerFor('another-tenant'));
  });

  it('is a plain OpenID Connect provider when the issuer is not one it composes', () => {
    const section = entra(FULL)!;
    const fields = allFields([section]);
    expect(fields.some((f) => f.kind === 'entra-tenant')).toBe(false);
    expect(fields.find((f) => f.path === 'auth.providers.entra.issuer')?.kind).toBe('text');
  });

  it('refuses the multi-tenant issuers in the pattern the browser checks', () => {
    const tenant = allFields([entra(WITH_ENTRA)!]).find((f) => f.kind === 'entra-tenant')!;
    const pattern = new RegExp(`^(?:${tenant.pattern})$`);
    expect(pattern.test('a-tenant-guid')).toBe(true);
    expect(pattern.test('contoso.onmicrosoft.com')).toBe(true);
    expect(pattern.test('common')).toBe(false);
    expect(pattern.test('organizations')).toBe(false);
    expect(pattern.test('consumers')).toBe(false);
  });
});

describe('a provider’s directory block', () => {
  const provider = (yaml: string) =>
    buildSections(loadDocument(yaml)).find((section) => section.parent === 'identity')!;

  const NO_DIRECTORY = FULL.replace(/ {6}directory:\n(?: {8}.+\n)+/g, '');

  const KEYS = ['type', 'tenant_id', 'client_id', 'client_secret', 'cache_ttl'];
  const pathsOf = (yaml: string) => allFields([provider(yaml)]).map((f) => f.path);

  const directoryOf = (yaml: string) =>
    (
      loadInstanceConfig(yaml).raw.auth?.providers?.entra as {
        directory?: Record<string, unknown>;
      }
    )?.directory;

  it('asks for every part of it on a provider that has none', () => {
    expect(NO_DIRECTORY).not.toContain('directory:');
    expect(pathsOf(NO_DIRECTORY)).toEqual(
      expect.arrayContaining(KEYS.map((key) => `auth.providers.entra.directory.${key}`)),
    );
  });

  it('stores the kind and the credentials it needs from one save', () => {
    const doc = loadDocument(NO_DIRECTORY);
    applyForm(
      doc,
      {
        'auth.providers.entra.directory.type': 'graph',
        'auth.providers.entra.directory.tenant_id': 'a-tenant',
        'auth.providers.entra.directory.client_id': 'a-client',
        'auth.providers.entra.directory.client_secret': '${TEST_ENTRA_CLIENT_SECRET}',
      },
      provider(NO_DIRECTORY).id,
    );

    expect(directoryOf(serialise(doc))).toEqual({
      type: 'graph',
      tenant_id: 'a-tenant',
      client_id: 'a-client',
      client_secret: process.env.TEST_ENTRA_CLIENT_SECRET,
    });
  });

  it('takes the block with it when the lookup is turned off', () => {
    const doc = loadDocument(FULL);
    applyForm(
      doc,
      {
        'auth.providers.entra.directory.type': '',
        'auth.providers.entra.directory.tenant_id': 'a-tenant',
        'auth.providers.entra.directory.client_id': 'a-client',
        'auth.providers.entra.directory.cache_ttl': '1h',
      },
      'identity/entra',
    );

    const out = serialise(doc);
    expect(() => loadInstanceConfig(out)).not.toThrow();
    expect(directoryOf(out)).toBeUndefined();
    expect(out).toContain('type: github');
    expect(
      (loadInstanceConfig(out).raw.auth?.providers?.hub as { directory?: unknown }).directory,
    ).toBeDefined();
  });

  it('leaves a page nobody touched exactly as it found it', () => {
    const body = untouchedBody(allFields([provider(FULL)]));

    const doc = loadDocument(FULL);
    expect(applyForm(doc, body, 'identity/entra').changed).toBe(false);
  });

  it('offers the sign-in app under each box it fills', () => {
    const fields = allFields([provider(FULL)]);
    const at = (key: string) =>
      fields.find((f) => f.path === `auth.providers.entra.directory.${key}`)!;
    const sourceToCopyFrom = (field: Field) =>
      'sourceToCopyFrom' in field ? field.sourceToCopyFrom : undefined;

    expect(sourceToCopyFrom(at('client_id'))).toBe('auth.providers.entra.client_id');
    expect(sourceToCopyFrom(at('client_secret'))).toBe('auth.providers.entra.client_secret');
    expect(sourceToCopyFrom(at('cache_ttl'))).toBeUndefined();
    for (const key of KEYS.slice(1)) {
      expect(at(key).shownWith).toBe('auth.providers.entra.directory.type');
    }
  });

  it('copies the tenant only from a control that is holding one', () => {
    const plain = ofKind(
      allFields([provider(FULL)]).find(
        (f) => f.path === 'auth.providers.entra.directory.tenant_id',
      ),
      'text',
    );
    expect(plain.sourceToCopyFrom).toBeUndefined();

    const entra = FULL.replace(
      'issuer: https://login.example.test/v2.0',
      `issuer: ${entraIssuerFor('a-tenant-guid')}`,
    );
    const composed = ofKind(
      allFields([provider(entra)]).find(
        (f) => f.path === 'auth.providers.entra.directory.tenant_id',
      ),
      'text',
    );
    expect(composed.sourceToCopyFrom).toBe('auth.providers.entra.issuer');
  });

  it('marks the one source the page cannot hand over, and copies it at the save', () => {
    const referenced = ofKind(
      allFields([provider(FULL)]).find(
        (f) => f.path === 'auth.providers.entra.directory.client_secret',
      ),
      'secret',
    );
    expect(referenced.sourceToCopyFromOnSave).toBe(false);

    const literal = FULL.replace(
      'client_secret: ${TEST_ENTRA_CLIENT_SECRET}\n      subject_claim',
      'client_secret: a-literal-secret\n      subject_claim',
    );
    const hidden = ofKind(
      allFields([provider(literal)]).find(
        (f) => f.path === 'auth.providers.entra.directory.client_secret',
      ),
      'secret',
    );
    expect(hidden.sourceToCopyFromOnSave).toBe(true);
    expect(JSON.stringify(hidden)).not.toContain('a-literal-secret');

    const doc = loadDocument(literal);
    applyForm(
      doc,
      {
        'auth.providers.entra.directory.type': 'graph',
        'auth.providers.entra.directory.client_secret': '',
        'copy:auth.providers.entra.directory.client_secret': 'on',
      },
      'identity/entra',
    );
    expect(directoryOf(serialise(doc))?.client_secret).toBe('a-literal-secret');
  });

  it('leaves a secret alone when nothing asked for the copy', () => {
    const literal = FULL.replace(
      'client_secret: ${TEST_ENTRA_CLIENT_SECRET}\n      subject_claim',
      'client_secret: a-literal-secret\n      subject_claim',
    ).replace(
      '        client_secret: ${TEST_ENTRA_CLIENT_SECRET}\n        cache_ttl: 1h',
      '        client_secret: a-directory-secret\n        cache_ttl: 1h',
    );
    const doc = loadDocument(literal);
    applyForm(
      doc,
      {
        'auth.providers.entra.directory.type': 'graph',
        'auth.providers.entra.directory.client_secret': '',
      },
      'identity/entra',
    );
    expect(directoryOf(serialise(doc))?.client_secret).toBe('a-directory-secret');
  });

  it('links a mapping to the group in the directory that owns it', () => {
    const entra = FULL.replace(
      'issuer: https://login.example.test/v2.0',
      `issuer: ${entraIssuerFor('a-tenant-guid')}`,
    );
    const source = buildSections(loadDocument(entra)).find(
      (section) => section.id === 'groups/engineering/entra',
    )!;
    const mapping = ofKind(
      allFields([source]).find((f) => /^groups\.engineering\.\d+\.id$/.test(f.path)),
      'text',
    );

    const link = renderHelp(mapping.link);
    expect(link).toContain('portal.azure.com');
    expect(link).toContain(`groupId/${mapping.value}`);
    expect(link).toContain('rel="noopener noreferrer nofollow"');
  });

  it('links nothing on a provider whose portal this is not', () => {
    const source = buildSections(loadDocument(FULL)).find(
      (section) => section.id === 'groups/engineering/entra',
    )!;
    const mapping = allFields([source]).find((f) => /^groups\.engineering\.\d+\.id$/.test(f.path))!;
    expect(mapping.link).toBe('');
  });

  it('offers nothing to copy on a GitHub directory, which has its own client', () => {
    const hub = buildSections(loadDocument(FULL)).find((s) => s.id === 'identity/hub')!;
    const fields = allFields([hub]);
    expect(
      fields.filter(
        (f) =>
          f.path.startsWith('auth.providers.hub.directory.') &&
          'sourceToCopyFrom' in f &&
          f.sourceToCopyFrom,
      ),
    ).toEqual([]);
  });
});

describe('the default switch', () => {
  const pageOf = (provider: string) => `identity/${provider}`;

  it('names this provider when it is ticked', () => {
    const doc = loadDocument(FULL);
    applyForm(doc, { 'auth.default_provider': 'on' }, pageOf('letter'));
    expect(serialise(doc)).toMatch(/default_provider: letter/);
  });

  it('clears the key when the provider it names turns it off', () => {
    const doc = loadDocument(FULL);
    expect(serialise(doc)).toMatch(/default_provider: entra/);
    applyForm(doc, {}, pageOf('entra'));
    expect(serialise(doc)).not.toMatch(/default_provider:/);
  });

  it('leaves a default naming somebody else alone', () => {
    const doc = loadDocument(FULL);
    applyForm(doc, {}, pageOf('letter'));
    expect(serialise(doc)).toMatch(/default_provider: entra/);
  });
});

describe('durations', () => {
  it('offer exactly the units the loader accepts, and no other', () => {
    const durations = allFields(buildSections(loadDocument(FULL))).filter(
      (f): f is FieldOf<'duration'> => f.kind === 'duration',
    );
    expect(durations.length).toBeGreaterThan(4);

    const schema = JSON.parse(
      readFileSync(join(__dirname, '../../src/config/schema/instance.schema.json'), 'utf8'),
    ) as { $defs: { duration: { pattern: string } } };
    const allowed = /\(([a-z|]+)\)\$$/.exec(schema.$defs.duration.pattern)?.[1].split('|');
    expect(allowed).toEqual(['s', 'm', 'h', 'd']);

    // A duration has no pattern of its own: the dropdown offers exactly the schema's units
    for (const field of durations) {
      expect(field.unitOptions.map((option) => option.value)).toEqual(allowed);
    }
  });

  it('take a value apart and put it back exactly as it was', () => {
    const doc = loadDocument(FULL_PRESIGNING);
    const before = serialise(doc);
    const section = sectionOf(doc, 'storage')!;
    const body = untouchedBody(allFields([section]));
    expect(body['assets.presign_ttl']).toBe('60');
    expect(body['unit:assets.presign_ttl']).toBe('s');
    expect(body['assets.max_asset_bytes']).toBe('10');
    expect(body['unit:assets.max_asset_bytes']).toBe('MB');

    expect(applyForm(doc, body, 'storage').changed).toBe(false);
    expect(serialise(doc)).toBe(before);
  });

  it('read an absent unit as the one the page was showing', () => {
    const doc = loadDocument(FULL);
    applyForm(doc, { 'auth.providers.entra.session_ttl': '8' }, 'identity/entra');
    expect(serialise(doc)).toContain('session_ttl: 8h');
  });

  it('multiply a size by the unit it was given in', () => {
    const doc = loadDocument(FULL);
    applyForm(
      doc,
      { 'assets.max_asset_bytes': '2', 'unit:assets.max_asset_bytes': 'GB' },
      'storage',
    );
    expect(serialise(doc)).toContain('max_asset_bytes: 2000000000');

    const field = (yaml: string) =>
      ofKind(
        fieldsFor(yaml).find((f) => f.path === 'assets.max_asset_bytes'),
        'bytes',
      );
    expect(field(FULL.replace('max_asset_bytes: 10000000', 'max_asset_bytes: 1500'))).toMatchObject(
      {
        value: '1500',
        unit: 'B',
      },
    );
    expect(field(FULL)).toMatchObject({ value: '10', unit: 'MB' });
  });

  it('keep a plain box for a value they cannot take apart', () => {
    const yaml = FULL_PRESIGNING.replace('presign_ttl: 60s', 'presign_ttl: ${ASSET_TTL}');
    const control = ofKind(
      fieldsFor(yaml).find((f) => f.path === 'assets.presign_ttl'),
      'duration',
    );
    expect(control.unitOptions).toEqual([]);
    expect(control.value).toBe('${ASSET_TTL}');

    const doc = loadDocument(yaml);
    expect(applyForm(doc, { 'assets.presign_ttl': '${ASSET_TTL}' }, 'storage').changed).toBe(false);
    expect(serialise(doc)).toContain('presign_ttl: ${ASSET_TTL}');
  });

  it('are not the only control carrying the loader’s own expression', () => {
    const ids = allFields(buildSections(loadDocument(FULL))).filter(
      (f): f is FieldOf<'text'> =>
        f.kind === 'text' && f.path.endsWith('.id') && f.path.startsWith('forges.'),
    );
    expect(ids.length).toBeGreaterThan(0);

    const schema = JSON.parse(
      readFileSync(join(__dirname, '../../src/config/schema/instance.schema.json'), 'utf8'),
    ) as { $defs: { repoId: { pattern: string } } };
    for (const field of ids) expect(schema.$defs.repoId.pattern).toBe(`^${field.pattern}$`);
  });

  it('compile the way a browser compiles a pattern attribute', () => {
    const sections = buildSections(loadDocument(FULL));
    const patterns = new Set<string>();
    const walk = (card: { addOps: { namePattern: string | null }[]; cards: unknown[] }) => {
      for (const add of card.addOps) if (add.namePattern) patterns.add(add.namePattern);
      (card.cards as (typeof card)[]).forEach(walk);
    };
    for (const section of sections) {
      if (section.renamePattern) patterns.add(section.renamePattern);
      walk(section);
    }
    for (const field of allFields(sections)) {
      if ('pattern' in field && field.pattern) patterns.add(field.pattern);
    }

    expect(patterns.size).toBeGreaterThan(3);
    for (const pattern of patterns) {
      expect(() => new RegExp(`^(?:${pattern})$`, 'v')).not.toThrow();
    }
  });

  it('say what they require, since the browser’s own refusal does not', () => {
    const sections = buildSections(loadDocument(FULL));
    const missing: string[] = [];
    type WithAdds = {
      addOps: { op: string; namePattern: string | null; nameHint: string | null }[];
      cards: unknown[];
    };
    const walk = (card: WithAdds) => {
      for (const add of card.addOps) if (add.namePattern && !add.nameHint) missing.push(add.op);
      (card.cards as WithAdds[]).forEach(walk);
    };
    for (const section of sections) {
      if (section.renamePattern && !section.renameHint) missing.push(`rename ${section.id}`);
      walk(section);
    }
    for (const field of allFields(sections)) {
      if ('pattern' in field && field.pattern && !field.patternHint) missing.push(field.path);
    }

    expect(missing).toEqual([]);
  });

  it('nor the last: a colour carries the loader\u2019s expression too', () => {
    const colours = allFields(buildSections(loadDocument(FULL))).filter((f) => f.kind === 'color');
    expect(colours.length).toBe(PALETTE_KEYS.length * 2);

    const schema = JSON.parse(
      readFileSync(join(__dirname, '../../src/config/schema/instance.schema.json'), 'utf8'),
    ) as { $defs: { colour: { pattern: string } } };
    for (const field of colours) expect(schema.$defs.colour.pattern).toBe(`^${field.pattern}$`);
  });

  it('still accepts an empty control, which is how a default stays a default', () => {
    const blank = new RegExp(`^(?:${'[0-9]+(s|m|h|d)'})$`);
    expect(blank.test('15m')).toBe(true);
    expect(blank.test('15')).toBe(false);
  });
});

describe('how an azure store authenticates', () => {
  const options = (yaml: string): string[] =>
    ofKind(
      fieldsFor(yaml).find((f) => f.path === 'assets.auth'),
      'select',
    ).options.map((option) => option.value);

  const AZURE = FULL.replace(
    'driver: filesystem',
    'driver: azure\n  account: acmedocs\n  container: assets',
  );

  const inProduction = (run: () => void): void => {
    const held = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      run();
    } finally {
      process.env.NODE_ENV = held;
    }
  };

  it('starts on the account key, in the schema and in the list', () => {
    const field = ofKind(
      fieldsFor(AZURE).find((f) => f.path === 'assets.auth'),
      'select',
    );
    expect(field.fallback).toBe('key');
    expect(field.options[0].value).toBe('key');

    const schema = JSON.parse(
      readFileSync(join(__dirname, '../../src/config/schema/instance.schema.json'), 'utf8'),
    ) as { properties: { assets: { properties: { auth: { default: string; enum: string[] } } } } };
    const auth = schema.properties.assets.properties.auth;
    expect(auth.default).toBe('key');
    expect(auth.enum[0]).toBe('key');
  });

  it('offers the SDK chain where development happens, and not in production', () => {
    expect(options(AZURE)).toContain('default');
    inProduction(() => expect(options(AZURE)).not.toContain('default'));
  });

  it('keeps offering it to an instance already using it', () => {
    const using = AZURE.replace('container: assets', 'container: assets\n  auth: default');
    inProduction(() => {
      expect(options(using)).toContain('default');
      expect(
        ofKind(
          fieldsFor(using).find((f) => f.path === 'assets.auth'),
          'select',
        ).value,
      ).toBe('default');
    });
  });
});

describe('the read-count switches', () => {
  const switchAt = (path: string) =>
    ofKind(
      fieldsFor('version: 1').find((f) => f.path === path),
      'boolean',
    );

  it('subordinates the two that do nothing while the master is off', () => {
    expect(switchAt('analytics.enabled').checked).toBe(false);
    for (const key of ['analytics.unique_readers', 'analytics.public_beacon']) {
      expect(switchAt(key).checked).toBe(true);
      expect(switchAt(key).shownWith).toBe('analytics.enabled');
    }
    expect(switchAt('analytics.enabled').shownWith).toBeUndefined();
  });

  it('leaves the boxes on screen, because they are answers and not claims', () => {
    for (const key of ['analytics.timezone', 'analytics.granularity', 'analytics.retention_days']) {
      expect(fieldsFor('version: 1').find((f) => f.path === key)?.shownWith).toBeUndefined();
    }
  });
});

describe('the time zone', () => {
  const zoneField = (yaml: string) =>
    ofKind(
      fieldsFor(yaml).find((f) => f.path === 'analytics.timezone'),
      'select',
    );

  it('offers only names the loader would accept', () => {
    const options = zoneField(FULL).options;
    expect(options.length).toBeGreaterThan(100);
    for (const option of options) expect(isKnownTimeZone(option.value)).toBe(true);
  });

  it('puts the default first, because a select with nothing stored shows the first', () => {
    const options = zoneField('version: 1').options;
    expect(options[0].value).toBe('UTC');
    expect(zoneField('version: 1').value).toBe('');
    expect(SCHEMA.properties.analytics.properties.timezone.default).toBe('UTC');
  });

  it('carries a stored value it does not recognise, rather than losing it', () => {
    for (const stored of ['Mars/Olympus_Mons', '${SPEICHER_TZ}']) {
      const field = zoneField(`version: 1\nanalytics:\n  timezone: "${stored}"`);
      expect(field.value).toBe(stored);
      expect(field.options.map((o) => o.value)).toContain(stored);
    }
  });

  it('writes what was picked, and nothing when the pick is the default', () => {
    const doc = loadDocument(FULL);
    applyForm(doc, { 'analytics.timezone': 'Pacific/Auckland' }, 'analytics');
    expect(serialise(doc)).toContain('timezone: Pacific/Auckland');

    const fresh = loadDocument('version: 1');
    applyForm(fresh, { 'analytics.timezone': 'UTC' }, 'analytics');
    expect(serialise(fresh)).not.toContain('timezone');
  });
});

describe('the defaults a new member arrives with', () => {
  const draft = (kind: string) => {
    const doc = loadDocument(FULL);
    setNodeAt(doc, ['auth', 'providers', 'fresh'], seedProvider(kind));
    const hint = { provider: 'fresh', kind };
    return { doc, section: sectionOf(doc, 'identity/fresh', hint)! };
  };

  it('fills the boxes that have one, from the field model rather than a second list', () => {
    const { section } = draft('magic-link');
    const duration = (key: string) =>
      ofKind(
        allFields([section]).find((f) => f.path.endsWith(key)),
        'duration',
      );

    expect(duration('token_ttl').value).toBe('15');
    expect(duration('token_ttl').unit).toBe('m');
    expect(duration('session_ttl').value).toBe('30');
    expect(duration('session_ttl').unit).toBe('d');
    expect(
      ofKind(
        allFields([draft('oidc').section]).find((f) => f.path.endsWith('issuer')),
        'text',
      ).value,
    ).toBe('');
  });

  const freshBlock = (doc: Document): string => {
    const lines = serialise(doc).split('\n');
    const start = lines.findIndex((line) => line.trim() === 'fresh:');
    const indent = lines[start].length - lines[start].trimStart().length;
    const rest = lines.slice(start + 1);
    const end = rest.findIndex(
      (line) => line.trim() !== '' && line.length - line.trimStart().length <= indent,
    );
    return rest.slice(0, end < 0 ? undefined : end).join('\n');
  };

  it('writes nothing into the document to fill a box', () => {
    const { doc, section } = draft('magic-link');
    expect(
      ofKind(
        allFields([section]).find((f) => f.path.endsWith('token_ttl')),
        'duration',
      ).value,
    ).toBe('15');
    expect(freshBlock(doc)).not.toContain('token_ttl');
    expect(freshBlock(doc)).not.toContain('same_browser');
  });

  it('leaves nothing behind when the form is saved untouched', () => {
    const { section } = draft('magic-link');
    const body: Record<string, unknown> = {};
    for (const f of allFields([section])) {
      const value = rendered(f);
      if (value !== undefined && value !== '') body[f.path] = value;
    }

    const saved = loadDocument(FULL);
    setNodeAt(saved, ['auth', 'providers', 'fresh'], seedProvider('magic-link'));
    applyForm(saved, body, section.id, { provider: 'fresh', kind: 'magic-link' });

    const block = freshBlock(saved);
    expect(block).toContain('type: magic-link');
    expect(block).not.toContain('token_ttl');
    expect(block).not.toContain('same_browser');
  });
});

describe('a group source', () => {
  const twice = () => {
    const doc = loadDocument(FULL);
    appendSeqItem(doc, ['groups', 'engineering'], { provider: 'entra', id: 'grp-eng-2' });
    return doc;
  };

  const rowsOf = (
    doc: ReturnType<typeof loadDocument>,
    sectionId: string,
    table?: string,
  ): SectionEntry[] => {
    const section = buildSections(doc).find((s) => s.id === sectionId)!;
    if (!section.tables) return section.entries;
    const wanted = table ?? section.tables[0].title;
    return section.tables.find((t) => t.title === wanted)!.entries;
  };

  const matchFieldsOf = (doc: ReturnType<typeof loadDocument>, sectionId: string, at = 0) =>
    Object.fromEntries(rowsOf(doc, sectionId)[at].fields.map((f) => [f.path.split('.').pop(), f]));

  it('is one row per provider, however many matches are written against it', () => {
    const rows = rowsOf(twice(), 'groups/engineering');
    expect(rows.map((r) => r.title)).toEqual(['entra']);
    expect(rows[0].lines.map((l) => l.value)).toEqual(['grp-eng', 'grp-eng-2']);
  });

  it('opens the provider, not the position — so the URL survives a removal above it', () => {
    expect(rowsOf(twice(), 'groups/engineering')[0].href).toBe(
      '/-/config/groups/engineering/entra',
    );
  });

  it('lists every match for that provider on its page, one row each', () => {
    const rows = rowsOf(twice(), 'groups/engineering/entra');
    expect(rows).toHaveLength(3);
    expect(rows[2].removeOp).toBeNull();
    expect(rows[0].href).toBe('');
    expect(rows[0].removeOp).toBe('remove:groups.engineering.0');
    expect(rows[1].removeOp).toBe('remove:groups.engineering.1');
  });

  it('asks a provider that emits group ids for an id, and carries the domain empty', () => {
    const fields = matchFieldsOf(loadDocument(FULL), 'groups/engineering/entra');
    expect(fields.id?.inapplicable).toBe(false);
    expect(fields.id?.value).toBe('grp-eng');
    expect(fields.domain?.inapplicable).toBe(true);
  });

  it('asks a magic-link provider for a domain, and carries the id empty', () => {
    const fields = matchFieldsOf(loadDocument(FULL), 'groups/everyone-at-example/letter');
    expect(fields.domain?.inapplicable).toBe(false);
    expect(fields.domain?.value).toBe('example.test');
    expect(fields.id?.inapplicable).toBe(true);
  });

  it('carries nothing in the key it does not ask for, so a save clears it', () => {
    const doc = loadDocument(FULL);
    doc.setIn(['groups', 'everyone-at-example', 0, 'id'], 'left-behind');
    expect(serialise(doc)).toContain('left-behind');

    const section = buildSections(doc).find((s) => s.id === 'groups/everyone-at-example/letter')!;
    const body = Object.fromEntries(allFields([section]).map((f) => [f.path, rendered(f)]));
    applyForm(doc, body, 'groups/everyone-at-example/letter');

    expect(serialise(doc)).not.toContain('left-behind');
    expect(serialise(doc)).toContain('example.test');
  });

  it('shows what a match looks like, from the provider’s own kind', () => {
    const doc = twice();
    appendSeqItem(doc, ['groups', 'engineering'], { provider: 'hub', id: 'acme/platform' });
    const placeholderOf = (sectionId: string) =>
      ofKind(
        rowsOf(doc, sectionId)[0].fields.find((f) => !f.inapplicable),
        'text',
      ).placeholder;

    expect(placeholderOf('groups/engineering/hub')).toBe('org/team-slug');
    expect(placeholderOf('groups/engineering/entra')).toBe('group identifier');
    expect(placeholderOf('groups/everyone-at-example/letter')).toBe('example.com');

    const entra = loadDocument(FULL);
    entra.setIn(
      ['auth', 'providers', 'entra', 'issuer'],
      'https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0',
    );
    expect(
      ofKind(
        rowsOf(entra, 'groups/engineering/entra')[0].fields.find((f) => !f.inapplicable),
        'text',
      ).placeholder,
    ).toMatch(/UUID/);
  });

  it('carries the provider’s own logo on the row, by kind', () => {
    const doc = loadDocument(FULL);
    const rowMark = (group: string) =>
      buildSections(doc).find((s) => s.id === `groups/${group}`)!.entries[0].mark;

    expect(rowMark('engineering')).toBe('openid');
    expect(rowMark('everyone-at-example')).toBe('mail');

    const index = buildSections(doc).find((s) => s.id === 'groups')!;
    const marks = index.entries.flatMap((e) => e.lines.map((l) => l.mark));
    expect(marks).toContain('openid');
    expect(marks).toContain('mail');
  });

  it('draws nothing for a source naming a provider this instance does not have', () => {
    const doc = loadDocument(FULL);
    doc.setIn(['groups', 'engineering', 0, 'provider'], 'nobody');
    expect(buildSections(doc).find((s) => s.id === 'groups/engineering')!.entries[0].mark).toBe('');
  });

  it('shows a source naming no provider, with no page and its own removal', () => {
    const doc = loadDocument(FULL);
    doc.deleteIn(['groups', 'engineering', 0, 'provider']);
    const row = buildSections(doc).find((s) => s.id === 'groups/engineering')!.entries[0];
    expect(row.title).toBe('no provider');
    expect(row.href).toBe('');
    expect(row.removeOp).toBe('remove:groups.engineering.0');
    expect(buildSections(doc).some((s) => s.id.startsWith('groups/engineering/'))).toBe(false);
  });

  it('removes every match under a provider when the source itself goes', () => {
    const doc = twice();
    applyForm(doc, { op: 'remove:groups.engineering.provider.entra' }, 'groups/engineering');
    expect(doc.toJS().groups.engineering).toEqual([]);

    expect(serialise(doc)).toContain('grp-ops');
  });

  it('adds a match on the provider whose page it was pressed on', () => {
    const doc = loadDocument(FULL);
    applyForm(doc, { op: 'add:groups.engineering.provider.entra' }, 'groups/engineering/entra');
    expect(doc.getIn(['groups', 'engineering', 1, 'provider'])).toBe('entra');
  });

  it('rebuilds a row added on a provider’s page as a row of that page', () => {
    const doc = loadDocument(FULL);
    const before = (doc.toJS().groups.engineering as unknown[]).length;
    applyForm(
      doc,
      {
        [`${SHAPE_PREFIX}groups.engineering`]: `${'group,'.repeat(before)}group`,
        [`groups.engineering.${before}.id`]: 'grp-typed-in',
      },
      'groups/engineering/entra',
    );

    expect(doc.getIn(['groups', 'engineering', before, 'provider'])).toBe('entra');
    expect(doc.getIn(['groups', 'engineering', before, 'id'])).toBe('grp-typed-in');
  });

  it('draws mappings and people as two tables, from one sequence', () => {
    const doc = loadDocument(FULL);
    appendSeqItem(doc, ['groups', 'engineering'], {
      provider: 'entra',
      email: 'alice@example.test',
      note: 'contractor',
    });
    appendSeqItem(doc, ['groups', 'engineering'], { provider: 'entra', id: 'grp-eng-2' });

    const section = buildSections(doc).find((s) => s.id === 'groups/engineering/entra')!;
    expect(section.tables?.map((t) => t.title)).toEqual(['entra groups', 'People']);

    expect(rowsOf(doc, section.id).map((e) => e.fields[0].path)).toEqual([
      'groups.engineering.0.id',
      'groups.engineering.2.id',
      'groups.engineering.3.id',
    ]);
    const people = rowsOf(doc, section.id, 'People');
    expect(people).toHaveLength(2);
    expect(people[0].fields.map((f) => f.path.split('.').pop())).toEqual([
      'subject',
      'email',
      'note',
      'until',
    ]);

    const shape = shapeControls(doc, section).find((c) => c.name.endsWith('groups.engineering'));
    expect(shape?.value).toBe('group,person,group');
  });

  it('gives a mapping a note and an expiry, as the people have', () => {
    const doc = loadDocument(FULL);
    const section = buildSections(doc).find((s) => s.id === 'groups/engineering/entra')!;
    expect(section.tables?.[0].columns.map((c) => c.label)).toEqual([
      'entra group id',
      'Note',
      'Expire by',
    ]);
    expect(section.tables?.[0].bulkRemoveOp).toBe('remove-selected:groups.engineering');

    const expireBy = section.tables![0].columns[2];
    expect(expireBy.help).toMatch(/a real expiry rather than a reminder/);

    const person = section.tables![1].columns[0];
    expect(person.help).toContain('`subject`');
    expect(renderHelp(person.help)).toContain('<code>subject</code>');
    expect(rowsOf(doc, section.id)[0].fields.map((f) => f.path.split('.').pop())).toEqual([
      'id',
      'domain',
      'note',
      'until',
    ]);
  });

  it('declares every path once per section, however many shapes render it', () => {
    const doc = loadDocument(FULL);
    for (const section of buildSections(doc)) {
      const paths = allFields([section]).map((f) => f.path);
      expect([section.id, [...new Set(paths)].length]).toEqual([section.id, paths.length]);
    }
  });

  it('seeds an added person with the key that makes them one', () => {
    expect(addTarget('add:groups.engineering.person.entra')).toEqual({
      path: 'groups.engineering',
      kind: 'person',
      seed: { provider: 'entra', email: '' },
    });
    expect(addTarget('add:groups.engineering.provider.entra')).toEqual({
      path: 'groups.engineering',
      kind: 'group',
      seed: { provider: 'entra' },
    });
  });

  it('carries every position of the list, whichever row draws it', () => {
    const doc = twice();
    const index = buildSections(doc).find((s) => s.id === 'groups/engineering')!;
    const carried = index.entries.flatMap((e) => e.carried.map((f) => f.path));
    expect(carried).toContain('groups.engineering.0.id');
    expect(carried).toContain('groups.engineering.1.id');
  });
});

describe('renaming a provider', () => {
  it('rewrites every reference in the document, and the result still loads', () => {
    const doc = loadDocument(FULL);
    expect(renameMember(doc, 'identity', 'entra', 'microsoft')).toBe(true);
    const out = serialise(doc);

    expect(out).toContain('microsoft:');
    expect(out).toMatch(/default_provider: microsoft/);
    expect(out).toContain("{ provider: microsoft, id: 'grp-eng' }");
    expect(out).toMatch(/- provider: microsoft/);
    expect(out).not.toMatch(/\bentra\b/);
    expect(() => loadInstanceConfig(out)).not.toThrow();
  });

  it('leaves every other provider alone', () => {
    const doc = loadDocument(FULL);
    renameMember(doc, 'identity', 'entra', 'microsoft');
    const out = serialise(doc);
    expect(out).toContain('letter:');
    expect(out).toContain('hub:');
    expect(out).toContain('{ provider: letter, domain: example.test }');
  });

  it('keeps the entry where it was, with everything else about it', () => {
    const before = loadDocument(FULL);
    const providers = (key: string) =>
      serialise(loadDocument(key))
        .split('\n')
        .filter((line) => /^ {4}\S+:$/.test(line))
        .map((line) => line.trim());

    const doc = loadDocument(FULL);
    renameMember(doc, 'identity', 'entra', 'microsoft');
    const after = providers(serialise(doc));

    expect(after).toEqual(
      providers(serialise(before)).map((k) => (k === 'entra:' ? 'microsoft:' : k)),
    );
    expect(serialise(doc)).toContain('subject_claim: oid');
  });

  const untouched = () => serialise(loadDocument(FULL));

  it('refuses a name another provider already has, rather than merging them', () => {
    const doc = loadDocument(FULL);
    expect(renameMember(doc, 'identity', 'entra', 'letter')).toBe(false);
    expect(serialise(doc)).toBe(untouched());
  });

  it('refuses a provider that is not there, and a rename to the same name', () => {
    const doc = loadDocument(FULL);
    expect(renameMember(doc, 'identity', 'nobody', 'somebody')).toBe(false);
    expect(renameMember(doc, 'identity', 'entra', 'entra')).toBe(false);
    expect(serialise(doc)).toBe(untouched());
  });

  it('writes nothing into the document on its own', () => {
    const doc = loadDocument(FULL);
    const before = serialise(doc);
    const result = applyForm(doc, { op: 'rename:groups.engineering' }, 'groups/engineering');
    expect(result.structural).toBe(false);
    expect(serialise(doc)).toBe(before);
  });

  it('is offered by the page of the provider it renames, and nowhere else', () => {
    const sections = buildSections(loadDocument(FULL));
    const page = sections.find((s) => s.id === 'identity/entra')!;
    const index = sections.find((s) => s.id === 'identity')!;

    expect(page.renameOp).toBe('rename:auth.providers.entra');
    expect(allOps([page])).toContain('rename:auth.providers.entra');
    expect(allOps([index])).not.toContain('rename:auth.providers.entra');
  });
});

describe('the id an Add control suggests', () => {
  it('offers the kind’s own name, and numbers it once that is taken', () => {
    expect(freeMemberId([], 'entra')).toBe('entra');
    expect(freeMemberId(['entra'], 'entra')).toBe('entra-2');
    expect(freeMemberId(['entra', 'entra-2'], 'entra')).toBe('entra-2'.replace('2', '3'));
    expect(freeMemberId(['entra', 'entra-3'], 'entra')).toBe('entra-2');
  });

  it('carries one per kind, because the wanted one depends on an untouched control', () => {
    const identity = buildSections(loadDocument(FULL)).find((s) => s.id === 'identity')!;
    const add = identity.addOps.find((op) => op.opensPage)!;
    const suggested = Object.fromEntries(add.typeOptions.map((o) => [o.value, o.suggest]));

    expect(suggested.entra).toBe('entra-2');
    expect(suggested.oidc).toBe('oidc');
    const taken = identity.entries.map((entry) => entry.title);
    expect(taken.length).toBeGreaterThan(1);
    for (const value of Object.values(suggested)) expect(taken).not.toContain(value);
  });
});

describe('a kind whose prerequisite is on another page', () => {
  function withoutMail(): Document {
    const doc = loadDocument(FULL);
    doc.delete('mail');
    return doc;
  }

  function kindOptions(doc: Document) {
    const identity = buildSections(doc).find((section) => section.id === 'identity')!;
    const add = identity.addOps.find((op) => op.opensPage)!;
    return Object.fromEntries(add.typeOptions.map((option) => [option.value, option] as const));
  }

  it('offers every kind while the transport is configured', () => {
    const offered = Object.values(kindOptions(loadDocument(FULL)));
    expect(offered.length).toBeGreaterThan(1);
    expect(offered.filter((option) => option.unavailable)).toEqual([]);
  });

  it('withholds the magic link when there is no transport, and says where to get one', () => {
    const options = kindOptions(withoutMail());
    expect(Object.keys(options)).toContain('magic-link');
    expect(options['magic-link'].unavailable).toContain('mail transport');
    expect(renderHelp(options['magic-link'].unavailable ?? '')).toMatch(
      /<a href="\/-\/config\/mail">[^<]+<\/a>/,
    );
    expect(CONFIG_SECTIONS.map((section) => section.id)).toContain('mail');
    expect(
      Object.entries(options)
        .filter(([, option]) => option.unavailable)
        .map(([value]) => value),
    ).toEqual(['magic-link']);
  });

  it('withholds it exactly when the loader would refuse the pairing', () => {
    const withMail = serialise(loadDocument(FULL));
    expect(() => loadInstanceConfig(withMail)).not.toThrow();

    const noMail = serialise(withoutMail());
    expect(noMail).toContain('type: magic-link');
    expect(() => loadInstanceConfig(noMail)).toThrow(/mail transport/);
  });
});

describe('the round trip', () => {
  function untouched(yaml: string): Record<string, unknown> {
    return untouchedBody(fieldsFor(yaml));
  }

  it('reports no change for a form nobody edited', () => {
    const doc = loadDocument(FULL);
    expect(applyAll(doc, untouched(FULL)).changed).toBe(false);
    const stored = applyAll(doc, untouched(FULL)).changed ? serialise(doc) : FULL;
    expect(stored).toBe(FULL);
  });

  it('keeps comments and key order when one field changes', () => {
    const doc = loadDocument(FULL);
    applyAll(doc, { ...untouched(FULL), 'theme.template': 'editorial' });
    const out = serialise(doc);

    expect(out).toContain('# One of everything.');
    expect(out).toContain(
      "# An ssh remote: a deploy key, checked against the forge's known_hosts.",
    );

    const before = FULL.split('\n');
    const after = out.split('\n');
    expect(after.length).toBe(before.length);

    const differing = after.filter((line, i) => line !== before[i]);
    expect(differing).toContain('  template: editorial');
    for (const line of differing) {
      if (line.includes('template: editorial')) continue;
      expect(line).toMatch(/\[ .* \]/);
    }
  });

  it('produces a document the loader still accepts', () => {
    const doc = loadDocument(FULL);
    applyAll(doc, { ...untouched(FULL), 'theme.template': 'editorial' });
    expect(() => loadInstanceConfig(serialise(doc))).not.toThrow();
  });

  it('removes a key rather than writing an empty string', () => {
    const doc = loadDocument(FULL);
    applyAll(doc, { ...untouched(FULL), 'mail.reply_to': '' });
    const out = serialise(doc);
    expect(out).not.toContain('reply_to');
    expect(out).toContain('from: Docs <docs@example.test>');
  });

  it('writes only paths the form rendered', () => {
    const doc = loadDocument(FULL);
    applyAll(doc, {
      ...untouched(FULL),
      'admins.users.0.subject': 'ops-oid',
      'auth.providers.smuggled.issuer': 'https://evil.test',
      'admins.groups.7': 'smuggled',
      version: '2',
    });
    const out = serialise(doc);
    expect(out).not.toContain('smuggled');
    expect(out).not.toContain('evil.test');
    expect(out).toContain('version: 1');
  });
});

describe('attached fields', () => {
  it('is reached by the walk decoding uses', () => {
    const fields = fieldsFor(FULL).map((f) => f.path);
    expect(fields).toContain('brand.name');
    expect(fields).toContain('brand.show_name');
  });

  it('is not also a field of the section in its own right', () => {
    const branding = buildSections(loadDocument(FULL)).find((s) => s.id === 'branding')!;
    expect(branding.fields.map((f) => f.path)).not.toContain('brand.show_name');
    expect(
      branding.fields.find((f) => f.path === 'brand.name')?.attached.map((f) => f.path),
    ).toEqual(['brand.show_name']);
  });

  it('is written by a save like any other field', () => {
    const doc = loadDocument(FULL);
    applyForm(doc, { 'brand.name': 'Acme Docs' }, 'branding');
    expect(serialise(doc)).toMatch(/show_name: false/);
  });
});

describe('help text markup', () => {
  it('escapes before it formats, so no source text can become an element', () => {
    expect(renderHelp('An <script>alert(1)</script> tag.')).toBe(
      'An &lt;script&gt;alert(1)&lt;/script&gt; tag.',
    );
    expect(renderHelp('**<b>x</b>**')).toBe('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
  });

  it('renders the six things it offers and nothing else', () => {
    expect(renderHelp('a `key`')).toBe('a <code>key</code>');
    expect(renderHelp('a **strong** word')).toBe('a <strong>strong</strong> word');
    expect(renderHelp('an _underlined_ word')).toBe('an <u>underlined</u> word');
    expect(renderHelp('a ==highlighted== word')).toBe('a <mark>highlighted</mark> word');
    expect(renderHelp('a == b, and c == d')).toBe('a == b, and c == d');
    expect(renderHelp('one line\n\nanother')).toBe('one line<br><br>another');
    expect(renderHelp('# not a heading\n- not a list')).toBe('# not a heading<br>- not a list');
  });

  it('does not underline the middle of a variable name', () => {
    expect(renderHelp('host of SPEICHER_PUBLIC_URL')).toBe('host of SPEICHER_PUBLIC_URL');
    expect(renderHelp('write ${VARIABLE_NAME} in the environment')).toBe(
      'write ${VARIABLE_NAME} in the environment',
    );
  });

  it('leaves a code span alone inside', () => {
    expect(renderHelp('`**stars** and _score_`')).toBe('<code>**stars** and _score_</code>');
  });

  it('links within this instance, and to https, and nowhere else', () => {
    expect(renderHelp('see [status](/-/status)')).toBe('see <a href="/-/status">status</a>');
    const out = renderHelp('see [docs](https://speicher.md/x)');
    expect(out).toContain(
      '<a href="https://speicher.md/x" target="_blank" rel="noopener noreferrer nofollow">docs',
    );
  });

  it('marks the link that leaves this instance, and only that one', () => {
    const external = renderHelp('see [docs](https://speicher.md/x)');
    expect(external).toContain('class="spr-external"');
    expect(external).toContain('<span class="spr-clipped"> (external link)</span>');

    const internal = renderHelp('see [status](/-/status)');
    expect(internal).not.toContain('spr-external');
    expect(internal).not.toContain('spr-clipped');
  });

  it('drops a link it will not emit rather than emitting it', () => {
    for (const href of [
      'javascript:alert(1)',
      '//evil.test/x',
      'data:text/html,x',
      'http://plain.test',
    ]) {
      const out = renderHelp(`go [there](${href})`);
      expect(out).not.toContain('<a');
      expect(out).toContain('there');
    }
  });

  it('emits nothing but its seven elements, over every help string the form has', () => {
    const html = allFields(buildSections(loadDocument(FULL)))
      .map((f) => renderHelp(f.help))
      .join('\n');
    const tags = [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase());
    const mark = [
      'svg',
      'span',
      'circle',
      'ellipse',
      'line',
      'path',
      'polygon',
      'polyline',
      'rect',
    ];
    expect(
      [...new Set(tags)].filter(
        (t) => !['code', 'strong', 'u', 'a', 'br', 'mark', ...mark].includes(t),
      ),
    ).toEqual([]);
  });
});

describe('an address typed without a scheme', () => {
  it('is saved with https in front of it', () => {
    expect(withHttpsScheme('fsn1.your-objectstorage.com')).toBe(
      'https://fsn1.your-objectstorage.com',
    );
    expect(withHttpsScheme('localhost:9000')).toBe('https://localhost:9000');
  });

  it('keeps whatever scheme it was given, so a development endpoint survives', () => {
    expect(withHttpsScheme('http://127.0.0.1:51000')).toBe('http://127.0.0.1:51000');
    expect(withHttpsScheme('https://fsn1.your-objectstorage.com')).toBe(
      'https://fsn1.your-objectstorage.com',
    );
  });

  it('leaves an empty box empty rather than saving a scheme on its own', () => {
    expect(withHttpsScheme('')).toBe('');
  });

  it('reaches the document with the scheme on it, where the schema will take it', () => {
    const doc = loadDocument(FULL_PRESIGNING);
    applyForm(doc, { 'assets.endpoint': 'fsn1.your-objectstorage.com' }, 'storage');

    expect(serialise(doc)).toContain('endpoint: https://fsn1.your-objectstorage.com');
  });

  it('is never assumed for a URL that is compared rather than dialled', () => {
    // An issuer is matched against the `iss` claim byte for byte, so a scheme
    // assumed on its behalf would break sign-in with a mismatch
    // Both documents, because the endpoint is only drawn for an object store
    const dialled = [...fieldsFor(FULL), ...fieldsFor(FULL_PRESIGNING)]
      .filter((field) => field.kind === 'url')
      .map((field) => field.path);

    expect(dialled).toContain('assets.endpoint');
    expect(dialled).toContain('embedding.base_url');
    expect(dialled.filter((path) => path.endsWith('issuer'))).toEqual([]);
  });

  it('leaves an issuer exactly as it was typed', () => {
    const doc = loadDocument(FULL);
    applyForm(doc, { 'auth.providers.entra.issuer': 'login.example.test/v2.0' }, 'identity/entra');

    expect(serialise(doc)).toContain('issuer: login.example.test/v2.0');
  });
});

describe('secrets', () => {
  it('renders an environment reference, because it names a secret rather than being one', () => {
    const field = ofKind(
      fieldsFor(FULL).find((f) => f.path === 'auth.providers.entra.client_secret'),
      'secret',
    );
    expect(field?.secretHidden).toBe(false);
    expect(field?.value).toBe('${TEST_ENTRA_CLIENT_SECRET}');
  });

  it('hides a literal, in the control and in the document view alike', () => {
    const literal = FULL.replace(
      'client_secret: ${TEST_ENTRA_CLIENT_SECRET}\n      subject_claim',
      'client_secret: a-real-secret-value\n      subject_claim',
    );
    expect(literal).not.toBe(FULL);

    const field = ofKind(
      fieldsFor(literal).find((f) => f.path === 'auth.providers.entra.client_secret'),
      'secret',
    );
    expect(field?.secretHidden).toBe(true);
    expect(field?.value).toBe('');

    const shown = displayYaml(literal);
    expect(shown).not.toContain('a-real-secret-value');
    expect(shown).toContain(REDACTED);
    expect(shown).toContain('${TEST_GH_PRIVATE_KEY}');
  });

  it('leaves a hidden literal alone when its control comes back blank', () => {
    const literal = FULL.replace(
      'client_secret: ${TEST_ENTRA_CLIENT_SECRET}\n      subject_claim',
      'client_secret: a-real-secret-value\n      subject_claim',
    );
    const doc = loadDocument(literal);
    applyForm(doc, { 'auth.providers.entra.client_secret': '' }, 'identity');
    expect(serialise(doc)).toContain('client_secret: a-real-secret-value');
  });

  it('redacts nothing, and rewrites nothing, when every secret is a reference', () => {
    const plain = FULL.replace(/\n {2}logo: data:[^\n]*/, '');
    expect(displayYaml(plain)).toBe(plain);
  });

  it('shows a marker in place of the logo, never its base64', () => {
    const shown = displayYaml(FULL);
    expect(shown).not.toContain('data:image/png;base64');
    expect(shown).toContain(ELIDED);
  });
});

describe("a GitHub provider's addresses", () => {
  const withPublicUrl = <T>(value: string | undefined, run: () => T): T => {
    const before = process.env.SPEICHER_PUBLIC_URL;
    if (value === undefined) delete process.env.SPEICHER_PUBLIC_URL;
    else process.env.SPEICHER_PUBLIC_URL = value;
    try {
      return run();
    } finally {
      if (before === undefined) delete process.env.SPEICHER_PUBLIC_URL;
      else process.env.SPEICHER_PUBLIC_URL = before;
    }
  };

  const copyValues = (id: string): CopyValueItem[] => {
    const section = buildSections(loadDocument(FULL)).find((s) => s.id === id)!;
    return cardItems([section]).filter((item): item is CopyValueItem => item.kind === 'copy-value');
  };

  it('offers the homepage and the callback to copy, from the declared public URL', () => {
    const [homepage, callback] = withPublicUrl('https://docs.acme.example/', () =>
      copyValues('identity/hub'),
    );

    expect(homepage.text).toBe('https://docs.acme.example');
    expect(callback.text).toBe('https://docs.acme.example/api/auth/github/callback');
  });

  it('offers the path when no public URL is declared, for the browser to complete', () => {
    const [homepage, callback] = withPublicUrl(undefined, () => copyValues('identity/hub'));

    expect(homepage.text).toBe('/');
    expect(callback.text).toBe('/api/auth/github/callback');
  });

  it('offers the callback the sign-in actually sends, not a second spelling of it', () => {
    // The two are the same constant; GitHub refuses a redirect_uri that differs from
    // the registered one, and says nothing about which address it expected
    const [, callback] = withPublicUrl('https://docs.acme.example', () =>
      copyValues('identity/hub'),
    );

    expect(callback.text.endsWith(GITHUB_CALLBACK_PATH)).toBe(true);
  });

  it('says nothing of the sort on a provider with no App to register them in', () => {
    const values = withPublicUrl('https://docs.acme.example', () => copyValues('identity/entra'));

    expect(values).toEqual([]);
  });
});

describe("a git remote's transport", () => {
  const SOURCE = 'sources/onprem';
  const repo = (index: number) => ['forges', 'onprem', 'repos', index];

  const choices = (doc: Document): ChoiceItem[] =>
    cardItems([buildSections(doc).find((s) => s.id === SOURCE)!]).filter(
      (item): item is ChoiceItem => item.kind === 'choice',
    );

  // The body of the page as drawn, with each switch on the option it shows
  const pageBody = (doc: Document): Record<string, unknown> => {
    const section = buildSections(doc).find((s) => s.id === SOURCE)!;
    const body = untouchedBody(allFields([section]));
    for (const item of choices(doc)) body[item.name] = item.selected;
    return body;
  };

  it('shows the option the stored URL belongs to', () => {
    const [ssh, https] = choices(loadDocument(FULL));
    expect(ssh.name).toBe('choice:forges.onprem.repos.0.url');
    expect(ssh.selected).toBe('ssh');
    expect(ssh.follows.path).toBe('forges.onprem.repos.0.url');
    expect(https.selected).toBe('https');
  });

  it('changes nothing on a save nobody touched', () => {
    const doc = loadDocument(FULL);
    const before = serialise(doc);
    expect(applyForm(doc, pageBody(doc), SOURCE).changed).toBe(false);
    expect(serialise(doc)).toBe(before);
  });

  it('removes the values of HTTPS when SSH is chosen, and keeps its own', () => {
    const doc = loadDocument(FULL);
    applyForm(
      doc,
      {
        ...pageBody(doc),
        'choice:forges.onprem.repos.1.url': 'ssh',
        'forges.onprem.repos.1.url': 'ssh://git@example.test/internal/playbooks.git',
        'forges.onprem.repos.1.deploy_key': '${TEST_GH_PRIVATE_KEY}',
      },
      SOURCE,
    );
    expect(doc.getIn([...repo(1), 'token'])).toBeUndefined();
    expect(doc.getIn([...repo(1), 'username'])).toBeUndefined();
    expect(doc.getIn([...repo(1), 'deploy_key'])).toBe('${TEST_GH_PRIVATE_KEY}');
    expect(doc.getIn([...repo(0), 'deploy_key'])).toBe('${TEST_GH_PRIVATE_KEY}');
  });

  it('follows the URL when the body names no option', () => {
    const doc = loadDocument(FULL);
    const body = pageBody(doc);
    delete body['choice:forges.onprem.repos.0.url'];
    body['forges.onprem.repos.0.url'] = 'https://example.test/internal/runbooks.git';
    applyForm(doc, body, SOURCE);
    expect(doc.getIn([...repo(0), 'deploy_key'])).toBeUndefined();
  });
});

describe("a GitHub source's webhook URL", () => {
  const withPublicUrl = <T>(value: string | undefined, run: () => T): T => {
    const before = process.env.SPEICHER_PUBLIC_URL;
    if (value === undefined) delete process.env.SPEICHER_PUBLIC_URL;
    else process.env.SPEICHER_PUBLIC_URL = value;
    try {
      return run();
    } finally {
      if (before === undefined) delete process.env.SPEICHER_PUBLIC_URL;
      else process.env.SPEICHER_PUBLIC_URL = before;
    }
  };

  const copyValues = (id: string): CopyValueItem[] => {
    const section = buildSections(loadDocument(FULL)).find((s) => s.id === id)!;
    return cardItems([section]).filter((item): item is CopyValueItem => item.kind === 'copy-value');
  };

  it('offers the absolute URL to copy, from the declared public URL and the forge id', () => {
    const [webhook] = withPublicUrl('https://docs.acme.example/', () => copyValues('sources/gh'));
    expect(webhook.text).toBe('https://docs.acme.example/-/hooks/gh');
    expect(webhook.note).toContain('**Webhook URL**');
  });

  it('offers the path to copy when no public URL is declared, for the browser to complete', () => {
    const [webhook] = withPublicUrl(undefined, () => copyValues('sources/gh'));
    expect(webhook.text).toBe('/-/hooks/gh');
    // One sentence for both: the browser completes the path, and without it the reader does
    expect(webhook.note).toContain('**Webhook URL**');
    expect(webhook.note).toContain('If only a path without a host is shown');
  });

  it('says nothing of the sort on a plain remote, which has no endpoint', () => {
    const values = withPublicUrl('https://docs.acme.example', () => copyValues('sources/onprem'));
    expect(values).toEqual([]);
  });
});

describe('a remote URL in the scp form', () => {
  it('becomes the ssh:// URL git reads it as', () => {
    expect(sshRemoteUrl('git@github.com:TimMolitor/TestSpeicher.git')).toBe(
      'ssh://git@github.com/TimMolitor/TestSpeicher.git',
    );
    expect(sshRemoteUrl('example.com:docs.git')).toBe('ssh://example.com/docs.git');
    expect(sshRemoteUrl('git@example.com:~/docs.git')).toBe('ssh://git@example.com/~/docs.git');
  });

  it('leaves every other URL as it is', () => {
    for (const url of [
      'ssh://git@github.com/TimMolitor/TestSpeicher.git',
      'ssh://git@example.com:2222/team/docs.git',
      'https://github.com/TimMolitor/TestSpeicher.git',
      '',
    ]) {
      expect(sshRemoteUrl(url)).toBe(url);
    }
  });

  it('is a pattern a browser accepts, and one that takes both SSH forms', () => {
    const ssh = new RegExp(`^(?:ssh://.*|${SCP_FORM})$`, 'v');
    expect(ssh.test('git@github.com:TimMolitor/TestSpeicher.git')).toBe(true);
    expect(ssh.test('ssh://git@github.com/TimMolitor/TestSpeicher.git')).toBe(true);
    expect(ssh.test('https://github.com/TimMolitor/TestSpeicher.git')).toBe(false);
  });

  it('is saved as its ssh:// URL', () => {
    const doc = loadDocument(
      'forges:\n  onprem:\n    type: git\n    repos:\n      - id: docs\n        url: https://example.com/team/docs.git\n',
    );
    applyForm(
      doc,
      {
        'forges.onprem.repos.0.url': 'git@github.com:TimMolitor/TestSpeicher.git',
        'choice:forges.onprem.repos.0.url': 'ssh',
      },
      'sources/onprem',
    );
    expect(doc.getIn(['forges', 'onprem', 'repos', 0, 'url'])).toBe(
      'ssh://git@github.com/TimMolitor/TestSpeicher.git',
    );
  });
});

describe('the id of a repository on a plain remote', () => {
  const idOf = (repo: Record<string, string>): string =>
    (repoCard({ forges: { onprem: { repos: [repo] } } }, 'onprem', 0).items[0] as { value: string })
      .value;

  it('takes the name of the repository from its remote URL', () => {
    expect(repositoryName('ssh://git@example.com/team/docs.git')).toBe('docs');
    expect(repositoryName('git@example.com:team/docs.git')).toBe('docs');
    expect(repositoryName('https://example.com/team/docs')).toBe('docs');
    expect(repositoryName('https://example.com/team/docs.git/')).toBe('docs');
  });

  it('takes nothing from a URL that names no repository', () => {
    expect(repositoryName('')).toBe('');
    expect(repositoryName('https://example.com')).toBe('');
  });

  it('fills in the id of a repository that has none, and keeps the one it has', () => {
    expect(idOf({ url: 'ssh://git@example.com/team/docs.git' })).toBe('docs');
    expect(idOf({ id: 'handbook', url: 'ssh://git@example.com/team/docs.git' })).toBe('handbook');
  });

  it('fills in nothing when the name of the repository is no valid id', () => {
    expect(idOf({ url: 'https://example.com/team/my docs.git' })).toBe('');
  });

  it('saves the name of the repository as the id when the id is left empty', () => {
    const doc = loadDocument(
      'forges:\n  onprem:\n    type: git\n    repos:\n      - id: docs\n        url: https://example.com/team/docs.git\n',
    );
    applyForm(
      doc,
      {
        'forges.onprem.repos.0.id': '',
        'forges.onprem.repos.0.url': 'git@github.com:TimMolitor/TestSpeicher.git',
        'choice:forges.onprem.repos.0.url': 'ssh',
      },
      'sources/onprem',
    );
    expect(doc.getIn(['forges', 'onprem', 'repos', 0, 'id'])).toBe('TestSpeicher');
  });
});
