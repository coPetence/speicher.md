import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Document } from 'yaml';
import { readStylesheet } from '../helpers/stylesheet';

import { GITHUB_CALLBACK_PATH } from '../../src/auth/callback-url';
import { ELIDED, REDACTED, displayYaml } from '../../src/dashboard/configurator/config-form/redact';
import { applyForm } from '../../src/dashboard/configurator/config-form/apply';
import {
  renameMember,
  seedMemberInto,
} from '../../src/dashboard/configurator/config-form/member-edits';
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
  isDisabledSection,
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
  if (field.kind === 'checkboxes' || field.kind === 'pick-list') return field.values;
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

  it('folds only the URL slug and the poll interval inside a card, which draws its own block', () => {
    const inCards: string[] = [];
    const walk = (card: Card): void => {
      for (const field of fieldsOf(card.items)) if (field.advanced) inCards.push(field.schemaPath);
      card.cards.forEach(walk);
    };
    for (const section of buildSections(loadDocument(FULL))) section.cards.forEach(walk);
    expect([...new Set(inCards)].sort()).toEqual([
      'forges.<key>.repos.<index>.poll_interval',
      'forges.<key>.repos.<index>.slug',
    ]);
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

const GITHUB_APP_STORED =
  'speicher.md writes it when it creates the GitHub App, and the card links to the App from it';

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
  'auth.providers.<key>.app.client_id': GITHUB_APP_STORED,
  'auth.providers.<key>.app.slug': GITHUB_APP_STORED,
  'auth.providers.<key>.app.owner_account': GITHUB_APP_STORED,
  'auth.providers.<key>.app.owner_is_organization': GITHUB_APP_STORED,
  'auth.providers.<key>.app.public': GITHUB_APP_STORED,
  'defaults.retrieval.indexable':
    'switching it off here cannot be undone by any repository, folder or page, so ' +
    'it turns off MCP search for the whole instance — the rare instance that wants ' +
    'that sets it in the YAML',
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
      .tables![0].add!;
    expect(add.kinds[0].options.length).toBeGreaterThan(12);
    expect(add.kinds[0].options.every((option) => option.mark !== '')).toBe(true);
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
        .filter((section) => section.parent === null && !isDisabledSection(section.id))
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
      expect(isConfigSubsection(section.id)).toBe(false);
      expect(section.entries).toEqual([]);
      expect(section.addOps).toEqual([]);
    }
    // Notifications is disabled for now, so only the relay has a page
    expect(isConfigSection('mail')).toBe(true);

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

  it('gives every feature of the link graph its own card, switched in its header', () => {
    const reading = buildSections(loadDocument(FULL)).find((s) => s.id === 'reading')!;

    expect(reading.fields.map((f) => f.schemaPath)).toEqual([
      'graph.enabled',
      'autolink.exclude_domains',
    ]);
    expect(reading.cards.map((card) => fieldsOf(card.items).map((f) => f.schemaPath))).toEqual([
      ['graph.related', 'graph.related_limit'],
      ['graph.previews'],
      ['graph.terms'],
      ['graph.search_boost'],
    ]);
    expect(reading.cards.map((card) => card.toggle)).toEqual([
      'graph.related',
      'graph.previews',
      'graph.terms',
      'graph.search_boost',
    ]);
    expect(reading.cardGrid).toBe(true);

    expect(reading.cards.every((card) => !card.titleIsKey)).toBe(true);
    expect(reading.cards.every((card) => card.subtitle !== '')).toBe(true);

    const limit = allFields([reading]).find((f) => f.schemaPath === 'graph.related_limit')!;
    expect(limit.shownWith).toBe('graph.related');

    expect(reading.cards.every((card) => card.enabledWith === 'graph.enabled')).toBe(true);
    expect(reading.cards.every((card) => card.shownWith === undefined)).toBe(true);
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
      (section) => section.id === 'groups/engineering',
    )!;
    const mapping = ofKind(
      allFields([source]).find((f) => /^groups\.engineering\.\d+\.id$/.test(f.path)),
      'text',
    );

    const link = renderHelp(mapping.link);
    expect(link).toContain('portal.azure.com');
    expect(link).toContain(`groupId/${mapping.value}`);
    expect(link).toContain('rel="noopener noreferrer nofollow"');

    // And the card's read-only line links out to the same page
    const line = source.tables![0].entries[0].lines[0];
    expect(line.href).toContain('portal.azure.com');
    expect(line.href).toContain(`groupId/${mapping.value}`);
  });

  it('links nothing on a provider whose portal this is not', () => {
    const source = buildSections(loadDocument(FULL)).find(
      (section) => section.id === 'groups/engineering',
    )!;
    const mapping = allFields([source]).find((f) => /^groups\.engineering\.\d+\.id$/.test(f.path))!;
    expect(mapping.link).toBe('');
    expect(source.tables![0].entries[0].lines[0].href).toBeUndefined();
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

describe('the include and exclude lists', () => {
  const listAt = (yaml: string, path: string) =>
    ofKind(
      fieldsFor(yaml).find((f) => f.path === path),
      'lines',
    );

  it('show the built-in globs while nothing is stored', () => {
    expect(listAt('version: 1', 'defaults.sync.include').value).toBe('**/*.md\n**/*.mdx');
    expect(listAt('version: 1', 'defaults.sync.exclude').value).toBe('**/README.md');
  });

  it('leave the document alone when saved untouched', () => {
    const doc = loadDocument('version: 1\n');
    const body = untouchedBody(allFields([sectionOf(doc, 'defaults')!]));
    expect(applyForm(doc, body, 'defaults').changed).toBe(false);
    expect(serialise(doc)).toBe('version: 1\n');
  });

  it('store an emptied list as empty, so the built-in globs do not return', () => {
    const doc = loadDocument('version: 1\n');
    applyForm(doc, { 'defaults.sync.exclude': '' }, 'defaults');
    expect(serialise(doc)).toContain('exclude: []');
    applyForm(doc, { 'defaults.sync.exclude': '' }, 'defaults');
    expect(serialise(doc)).toContain('exclude: []');
    expect(listAt(serialise(doc), 'defaults.sync.exclude').value).toBe('');
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

describe('a group’s rows', () => {
  const twice = () => {
    const doc = loadDocument(FULL);
    appendSeqItem(doc, ['groups', 'engineering'], { provider: 'entra', id: 'grp-eng-2' });
    return doc;
  };

  const mixed = () => {
    const doc = loadDocument(FULL);
    appendSeqItem(doc, ['groups', 'engineering'], {
      provider: 'entra',
      email: 'alice@example.test',
      note: 'contractor',
    });
    appendSeqItem(doc, ['groups', 'engineering'], { group: 'platform-ops' });
    appendSeqItem(doc, ['groups', 'engineering'], { provider: 'letter', domain: 'example.test' });
    return doc;
  };

  const rowsOf = (doc: ReturnType<typeof loadDocument>, name: string): SectionEntry[] =>
    buildSections(doc).find((s) => s.id === `groups/${name}`)!.tables![0].entries;

  const keysOf = (row: SectionEntry) => row.fields.map((f) => f.path.split('.').pop());

  const fieldsOf = (doc: ReturnType<typeof loadDocument>, name: string, at = 0) =>
    Object.fromEntries(rowsOf(doc, name)[at].fields.map((f) => [f.path.split('.').pop(), f]));

  it('is one row per item of the list, in the order the document has them', () => {
    const rows = rowsOf(mixed(), 'engineering');
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2, 3]);
    expect(rows.map((r) => r.title)).toEqual([
      'IDP group',
      'Individual email',
      'Group',
      'Email domain',
    ]);
    expect(rows.map((r) => r.subtitle)).toEqual(['entra', 'entra', '', 'letter']);
    expect(rows.map((r) => r.kind)).toEqual(['group', 'person', 'reference', 'group']);
    expect(rows.map((r) => r.removeOp)).toEqual(
      [0, 1, 2, 3].map((i) => `remove:groups.engineering.${i}`),
    );
    expect(rows.every((r) => r.href === '')).toBe(true);
  });

  it('has no page per provider any more, only the group’s own', () => {
    expect(buildSections(mixed()).some((s) => s.id.startsWith('groups/engineering/'))).toBe(false);
    const page = buildSections(mixed()).find((s) => s.id === 'groups/engineering')!;
    expect(page.tables).toHaveLength(1);
    expect(page.tables![0].bulkRemoveOp).toBe('remove-selected:groups.engineering');
    expect(page.tables![0].columns).toEqual([]);
    // The expiry's help travels with its control, which only the opened card shows
    const until = page.tables![0].entries[0].fields.find((f) => f.path.endsWith('.until'))!;
    expect(until.help).toMatch(/A date in the past removes the member immediately/);
  });

  it('says what a row matches, its note, and its expiry in words', () => {
    const doc = loadDocument(FULL);
    doc.setIn(['groups', 'engineering', 0, 'note'], 'the Engineering list');
    doc.setIn(['groups', 'engineering', 0, 'until'], '2099-01-01');
    const lines = rowsOf(doc, 'engineering')[0].lines;
    expect(lines.map((l) => l.label)).toEqual(['Group', 'Note', 'Expire by']);
    expect(lines[0].value).toBe('grp-eng');
    expect(lines[1].value).toBe('the Engineering list');
    expect(lines[2].value).toMatch(/^expires in \d+ years \(2099-01-01\)$/);

    expect(lines[2].failed).toBe(false);

    const bare = rowsOf(loadDocument(FULL), 'engineering')[0].lines;
    expect(bare[1].value).toBe('');
    expect(bare[2].value).toBe('');
    expect(bare[2].failed).toBe(false);

    doc.setIn(['groups', 'engineering', 0, 'until'], '2020-01-01');
    const passed = rowsOf(doc, 'engineering')[0].lines[2];
    expect(passed.value).toMatch(/^expired \d+ years ago \(2020-01-01\)$/);
    expect(passed.failed).toBe(true);
  });

  it('asks each shape for its own key, and a note and an expiry on every one', () => {
    const doc = mixed();
    expect(keysOf(rowsOf(doc, 'engineering')[0])).toEqual(['id', 'domain', 'note', 'until']);
    expect(keysOf(rowsOf(doc, 'engineering')[1])).toEqual(['subject', 'email', 'note', 'until']);
    expect(keysOf(rowsOf(doc, 'engineering')[2])).toEqual(['group', 'note', 'until']);
  });

  it('asks a provider that emits group ids for an id, and carries the domain empty', () => {
    const fields = fieldsOf(loadDocument(FULL), 'engineering');
    expect(fields.id?.inapplicable).toBe(false);
    expect(fields.id?.value).toBe('grp-eng');
    expect(fields.domain?.inapplicable).toBe(true);
  });

  it('asks a magic-link provider for a domain, and carries the id empty', () => {
    const fields = fieldsOf(loadDocument(FULL), 'everyone-at-example');
    expect(fields.domain?.inapplicable).toBe(false);
    expect(fields.domain?.value).toBe('example.test');
    expect(fields.id?.inapplicable).toBe(true);
  });

  it('offers a reference every other group, and never the group itself', () => {
    const select = ofKind(fieldsOf(loadDocument(FULL), 'tech').group, 'select');
    expect(select.value).toBe('engineering');
    expect(select.options.map((o) => o.value)).toEqual([
      'engineering',
      'everyone-at-example',
      'platform-ops',
    ]);
  });

  it('keeps showing a reference to a group that is not there, rather than picking another', () => {
    const doc = loadDocument(FULL);
    doc.setIn(['groups', 'tech', 0, 'group'], 'nobody');
    const select = ofKind(fieldsOf(doc, 'tech').group, 'select');
    expect(select.value).toBe('nobody');
    expect(select.options[0].value).toBe('nobody');
  });

  it('carries the provider on a source, and nothing on a reference', () => {
    const rows = rowsOf(mixed(), 'engineering');
    expect(rows[0].carried.map((f) => f.path)).toEqual(['groups.engineering.0.provider']);
    expect(rows[2].carried).toEqual([]);
  });

  it('carries nothing in the key it does not ask for, so a save clears it', () => {
    const doc = loadDocument(FULL);
    doc.setIn(['groups', 'everyone-at-example', 0, 'id'], 'left-behind');
    expect(serialise(doc)).toContain('left-behind');

    const section = buildSections(doc).find((s) => s.id === 'groups/everyone-at-example')!;
    const body = Object.fromEntries(allFields([section]).map((f) => [f.path, rendered(f)]));
    applyForm(doc, body, 'groups/everyone-at-example');

    expect(serialise(doc)).not.toContain('left-behind');
    expect(serialise(doc)).toContain('example.test');
  });

  it('shows what a match looks like, from the provider’s own kind', () => {
    const doc = twice();
    appendSeqItem(doc, ['groups', 'engineering'], { provider: 'hub', id: 'acme/platform' });
    const placeholderOf = (name: string, at: number) =>
      ofKind(
        rowsOf(doc, name)[at].fields.find((f) => !f.inapplicable),
        'text',
      ).placeholder;

    expect(placeholderOf('engineering', 2)).toBe('org/team-slug');
    expect(placeholderOf('engineering', 0)).toBe('group identifier');
    expect(placeholderOf('everyone-at-example', 0)).toBe('example.com');

    const entra = loadDocument(FULL);
    entra.setIn(
      ['auth', 'providers', 'entra', 'issuer'],
      'https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0',
    );
    expect(
      ofKind(
        rowsOf(entra, 'engineering')[0].fields.find((f) => !f.inapplicable),
        'text',
      ).placeholder,
    ).toMatch(/UUID/);
  });

  it('carries the provider’s own logo on the row, by kind', () => {
    const doc = loadDocument(FULL);
    expect(rowsOf(doc, 'engineering')[0].mark).toBe('openid');
    expect(rowsOf(doc, 'everyone-at-example')[0].mark).toBe('mail');
    expect(rowsOf(doc, 'tech')[0].mark).toBe('');

    const index = buildSections(doc).find((s) => s.id === 'groups')!;
    const marks = index.entries.flatMap((e) => e.lines.map((l) => l.mark));
    expect(marks).toContain('openid');
    expect(marks).toContain('mail');
  });

  it('says on the index which groups a group is made of', () => {
    const index = buildSections(loadDocument(FULL)).find((s) => s.id === 'groups')!;
    const tech = index.entries.find((e) => e.title === 'tech')!;
    expect(tech.lines.map((l) => l.value)).toEqual(['groups (engineering, platform-ops)']);
    expect(tech.search).toContain('platform-ops');
  });

  it('draws nothing for a source naming a provider this instance does not have', () => {
    const doc = loadDocument(FULL);
    doc.setIn(['groups', 'engineering', 0, 'provider'], 'nobody');
    expect(rowsOf(doc, 'engineering')[0].mark).toBe('');
    expect(rowsOf(doc, 'engineering')[0].subtitle).toBe('nobody');
  });

  it('shows a source naming no provider, with its own removal', () => {
    const doc = loadDocument(FULL);
    doc.deleteIn(['groups', 'engineering', 0, 'provider']);
    const row = rowsOf(doc, 'engineering')[0];
    expect(row.title).toBe('IDP group');
    expect(row.subtitle).toBe('');
    expect(row.removeOp).toBe('remove:groups.engineering.0');
  });

  it('offers every shape of row this instance can take, each through what fits it', () => {
    const page = buildSections(loadDocument(FULL)).find((s) => s.id === 'groups/engineering')!;
    expect(page.addOps).toEqual([]);
    const add = page.tables![0].add!;
    expect(add.op).toBe('add:groups.engineering.row');
    expect(add.kinds.map((k) => k.value)).toEqual(['person', 'group', 'domain', 'reference']);
    // A provider is never picked for you
    expect(add.kinds.filter((k) => !k.multiple).every((k) => k.placeholder)).toBe(true);

    const options = (value: string) => add.kinds.find((k) => k.value === value)!.options;
    expect(options('group').map((o) => o.value)).toEqual(['entra', 'hub']);
    expect(options('domain').map((o) => o.value)).toEqual(['letter']);
    expect(options('person').map((o) => o.value)).toEqual(['entra', 'letter', 'hub']);
    // `tech` already references this group, so naming it here would close a cycle
    expect(options('reference').map((o) => o.value)).toEqual([
      'everyone-at-example',
      'platform-ops',
    ]);
    expect(options('person').every((o) => o.mark !== '')).toBe(true);
  });

  it('offers no group already named, nor one that reaches this group', () => {
    const doc = loadDocument(FULL);
    doc.setIn(['groups', 'staff'], doc.createNode([{ group: 'tech' }]));
    const options = (name: string) =>
      buildSections(doc)
        .find((s) => s.id === `groups/${name}`)!
        .tables![0].add!.kinds.find((k) => k.value === 'reference')!
        .options.map((o) => o.value);
    expect(options('engineering')).toEqual(['everyone-at-example', 'platform-ops']);
    // `tech` names both of the others already, and `staff` reaches it
    expect(options('tech')).toEqual(['everyone-at-example']);
    // An existing reference row may still be pointed at any group but a referrer
    const row = rowsOf(doc, 'tech')[0].fields.find((f) => f.path.endsWith('.group'))!;
    expect((row as { options: { value: string }[] }).options.map((o) => o.value)).toEqual([
      'engineering',
      'everyone-at-example',
      'platform-ops',
    ]);
  });

  it('leaves out a shape nothing can take, and the control when none can', () => {
    const lone = loadDocument(FULL);
    for (const name of ['everyone-at-example', 'platform-ops', 'tech']) {
      lone.deleteIn(['groups', name]);
    }
    lone.deleteIn(['admins', 'groups']);
    lone.deleteIn(['auth', 'providers', 'letter']);
    expect(
      buildSections(lone)
        .find((s) => s.id === 'groups/engineering')!
        .tables![0].add!.kinds.map((k) => k.value),
    ).toEqual(['person', 'group']);

    const nothing = loadDocument(FULL);
    nothing.deleteIn(['auth']);
    for (const name of ['everyone-at-example', 'platform-ops', 'tech']) {
      nothing.deleteIn(['groups', name]);
    }
    nothing.deleteIn(['admins']);
    expect(
      buildSections(nothing).find((s) => s.id === 'groups/engineering')!.tables![0].add,
    ).toBeUndefined();
  });

  it('grows the list the modal belongs to', () => {
    expect(addTarget('add:groups.engineering.row')).toEqual({ path: 'groups.engineering' });
    expect(addTarget('add:forges.onprem.repos')).toEqual({ path: 'forges.onprem.repos' });
  });

  it('appends a mapping asking for the key its provider matches on', () => {
    const doc = loadDocument(FULL);
    applyForm(
      doc,
      {
        op: 'add:groups.engineering.row',
        'newkind:groups.engineering.row': 'group',
        'newname:groups.engineering.row.group': 'entra',
      },
      'groups/engineering',
    );
    expect(doc.toJS().groups.engineering[1]).toEqual({ provider: 'entra', id: '' });

    applyForm(
      doc,
      {
        op: 'add:groups.engineering.row',
        'newkind:groups.engineering.row': 'domain',
        'newname:groups.engineering.row.domain': 'letter',
      },
      'groups/engineering',
    );
    // The empty mapping above was dropped by the save that added this one
    expect(doc.toJS().groups.engineering[1]).toEqual({ provider: 'letter', domain: '' });
  });

  it('appends a row per line typed into the modal, each with its provider', () => {
    const doc = loadDocument(FULL);
    applyForm(
      doc,
      {
        op: 'add:groups.engineering.row',
        'newkind:groups.engineering.row': 'group',
        'newname:groups.engineering.row.group': 'entra',
        'newmatches:groups.engineering.row.group': ' grp-one \n\ngrp-two\r\n',
      },
      'groups/engineering',
    );
    expect(doc.toJS().groups.engineering.slice(1)).toEqual([
      { provider: 'entra', id: 'grp-one' },
      { provider: 'entra', id: 'grp-two' },
    ]);

    applyForm(
      doc,
      {
        op: 'add:groups.engineering.row',
        'newkind:groups.engineering.row': 'person',
        'newname:groups.engineering.row.person': 'letter',
        'newmatches:groups.engineering.row.person': 'alice@example.test',
      },
      'groups/engineering',
    );
    expect(doc.toJS().groups.engineering[3]).toEqual({
      provider: 'letter',
      email: 'alice@example.test',
    });
    expect(
      buildSections(loadDocument(FULL))
        .find((s) => s.id === 'groups/engineering')!
        .tables![0].add!.kinds.map((k) => k.matches?.label),
    ).toEqual(['Email addresses', 'Group ids', 'Email domains', undefined]);
  });

  it('appends a person with the key that makes them one', () => {
    const doc = loadDocument(FULL);
    applyForm(
      doc,
      {
        op: 'add:groups.engineering.row',
        'newkind:groups.engineering.row': 'person',
        'newname:groups.engineering.row.person': 'entra',
      },
      'groups/engineering',
    );
    expect(doc.toJS().groups.engineering[1]).toEqual({ provider: 'entra', email: '' });
  });

  it('appends a reference per group that was ticked', () => {
    const doc = loadDocument(FULL);
    applyForm(
      doc,
      {
        op: 'add:groups.engineering.row',
        'newkind:groups.engineering.row': 'reference',
        'newname:groups.engineering.row.reference': 'platform-ops',
      },
      'groups/engineering',
    );
    expect(doc.toJS().groups.engineering[1]).toEqual({ group: 'platform-ops' });

    applyForm(
      doc,
      {
        op: 'add:groups.engineering.row',
        'newkind:groups.engineering.row': 'reference',
        'newname:groups.engineering.row.reference': [
          'engineering',
          'nobody',
          'everyone-at-example',
        ],
      },
      'groups/engineering',
    );
    expect(doc.toJS().groups.engineering.slice(2)).toEqual([{ group: 'everyone-at-example' }]);

    const kinds = buildSections(loadDocument(FULL)).find((s) => s.id === 'groups/engineering')!
      .tables![0].add!.kinds;
    expect(kinds.map((k) => k.multiple ?? false)).toEqual([false, false, false, true]);
  });

  it('appends nothing for a name the document does not have, the group itself, or a shape the provider cannot take', () => {
    const doc = loadDocument(FULL);
    const before = serialise(doc);
    applyForm(
      doc,
      {
        op: 'add:groups.engineering.row',
        'newkind:groups.engineering.row': 'group',
        'newname:groups.engineering.row.group': 'nobody',
      },
      'groups/engineering',
    );
    applyForm(
      doc,
      {
        op: 'add:groups.engineering.row',
        'newkind:groups.engineering.row': 'reference',
        'newname:groups.engineering.row.reference': 'nobody',
      },
      'groups/engineering',
    );
    applyForm(
      doc,
      {
        op: 'add:groups.engineering.row',
        'newkind:groups.engineering.row': 'reference',
        'newname:groups.engineering.row.reference': 'engineering',
      },
      'groups/engineering',
    );
    // A domain through a provider that signs people in by group, and the other way round
    applyForm(
      doc,
      {
        op: 'add:groups.engineering.row',
        'newkind:groups.engineering.row': 'domain',
        'newname:groups.engineering.row.domain': 'entra',
      },
      'groups/engineering',
    );
    applyForm(
      doc,
      {
        op: 'add:groups.engineering.row',
        'newkind:groups.engineering.row': 'group',
        'newname:groups.engineering.row.group': 'letter',
      },
      'groups/engineering',
    );
    expect(serialise(doc)).toBe(before);
  });

  it('drops a row nobody typed into on the save after it was added', () => {
    const doc = loadDocument(FULL);
    applyForm(
      doc,
      {
        op: 'add:groups.engineering.row',
        'newkind:groups.engineering.row': 'person',
        'newname:groups.engineering.row.person': 'entra',
      },
      'groups/engineering',
    );
    const section = buildSections(doc).find((s) => s.id === 'groups/engineering')!;
    const body = Object.fromEntries(allFields([section]).map((f) => [f.path, rendered(f)]));
    applyForm(doc, body, 'groups/engineering');
    expect(doc.toJS().groups.engineering).toEqual([{ provider: 'entra', id: 'grp-eng' }]);
  });

  it('keeps a row that was typed into, with its provider', () => {
    const doc = loadDocument(FULL);
    applyForm(
      doc,
      {
        op: 'add:groups.engineering.row',
        'newkind:groups.engineering.row': 'person',
        'newname:groups.engineering.row.person': 'entra',
      },
      'groups/engineering',
    );
    const section = buildSections(doc).find((s) => s.id === 'groups/engineering')!;
    const body = Object.fromEntries(allFields([section]).map((f) => [f.path, rendered(f)]));
    applyForm(
      doc,
      { ...body, 'groups.engineering.1.email': 'alice@example.test' },
      'groups/engineering',
    );
    expect(doc.toJS().groups.engineering[1]).toEqual({
      provider: 'entra',
      email: 'alice@example.test',
    });
  });

  it('tells the page the shape of every position, each row its own', () => {
    const doc = mixed();
    const section = buildSections(doc).find((s) => s.id === 'groups/engineering')!;
    const shape = shapeControls(doc, section).find((c) => c.name.endsWith('groups.engineering'));
    expect(shape?.value).toBe('group,person,reference,group');
    expect(section.tables![0].entries.map((entry) => entry.kind)).toEqual([
      'group',
      'person',
      'reference',
      'group',
    ]);
  });

  it('rebuilds a position in the shape the page says it holds, so the values land', () => {
    // The person at 1 was removed in the browser, which renumbered the reference
    // and the domain behind it; the page says what each position is now
    const doc = mixed();
    applyForm(
      doc,
      {
        [`${SHAPE_PREFIX}groups.engineering`]: 'group,reference,group',
        'groups.engineering.0.provider': 'entra',
        'groups.engineering.0.id': 'grp-eng',
        'groups.engineering.1.group': 'platform-ops',
        'groups.engineering.2.provider': 'letter',
        'groups.engineering.2.domain': 'example.test',
        'groups.engineering.2.id': '',
      },
      'groups/engineering',
    );
    expect(doc.toJS().groups.engineering).toEqual([
      { provider: 'entra', id: 'grp-eng' },
      { group: 'platform-ops' },
      { provider: 'letter', domain: 'example.test' },
    ]);
  });

  it('appends no reference that is already there or would close a cycle', () => {
    const doc = loadDocument(FULL);
    const before = serialise(doc);
    applyForm(
      doc,
      {
        op: 'add:groups.engineering.row',
        'newkind:groups.engineering.row': 'reference',
        // `tech` references `engineering` already
        'newname:groups.engineering.row.reference': 'tech',
      },
      'groups/engineering',
    );
    expect(serialise(doc)).toBe(before);

    applyForm(
      doc,
      {
        op: 'add:groups.tech.row',
        'newkind:groups.tech.row': 'reference',
        'newname:groups.tech.row.reference': ['engineering', 'platform-ops', 'platform-ops'],
      },
      'groups/tech',
    );
    expect(doc.toJS().groups.tech.filter((item: { group?: string }) => item.group)).toEqual([
      { group: 'engineering', note: 'every engineer' },
      { group: 'platform-ops' },
    ]);
  });

  it('keeps the key order of a hand-written source through an untouched save', () => {
    const yaml = FULL.replace(
      "  engineering:\n    - { provider: entra, id: 'grp-eng' }",
      '  engineering:\n    - id: grp-eng\n      provider: entra',
    );
    expect(yaml).not.toBe(FULL);
    const doc = loadDocument(yaml);
    const section = sectionOf(doc, 'groups/engineering')!;
    const body = untouchedBody(allFields([section]));
    expect(applyForm(doc, body, 'groups/engineering').changed).toBe(false);
    expect(serialise(doc)).toBe(serialise(loadDocument(yaml)));
  });

  it('declares every path once per section, however many shapes render it', () => {
    const doc = loadDocument(FULL);
    for (const section of buildSections(doc)) {
      const paths = allFields([section]).map((f) => f.path);
      expect([section.id, [...new Set(paths)].length]).toEqual([section.id, paths.length]);
    }
  });

  it('renames a group in every reference to it, and the result still loads', () => {
    const doc = loadDocument(FULL);
    expect(renameMember(doc, 'groups', 'engineering', 'eng')).toBe(true);
    const out = serialise(doc);
    expect(out).toContain('  eng:\n');
    expect(out).toContain('{ group: eng, note: every engineer }');
    expect(out).not.toMatch(/group: engineering\b/);
    expect(() => loadInstanceConfig(out)).not.toThrow();
  });
});

describe('adding the first provider or source', () => {
  it('makes the first one the default, in writing', () => {
    const doc = loadDocument('version: 1\n');
    seedMemberInto(doc, { section: 'identity', id: 'entra' }, 'entra');

    expect(doc.getIn(['auth', 'default_provider'])).toBe('entra');
  });

  it('leaves the default alone once there is a provider already', () => {
    const doc = loadDocument('version: 1\nauth:\n  providers:\n    entra:\n      type: oidc\n');
    seedMemberInto(doc, { section: 'identity', id: 'letter' }, 'magic-link');

    expect(doc.getIn(['auth', 'default_provider'])).toBeUndefined();
  });

  it('keeps a default that is already written, even with no provider left', () => {
    const doc = loadDocument('version: 1\nauth:\n  default_provider: entra\n  providers: {}\n');
    seedMemberInto(doc, { section: 'identity', id: 'letter' }, 'magic-link');

    expect(doc.getIn(['auth', 'default_provider'])).toBe('entra');
  });

  it('makes the first content source the primary, so its URLs never move', () => {
    const doc = loadDocument('version: 1\n');
    seedMemberInto(doc, { section: 'sources', id: 'gh' }, 'github');

    expect(doc.getIn(['forges', 'gh', 'primary'])).toBe(true);
  });

  it('leaves the primary to the existing source when a second one joins', () => {
    const doc = loadDocument('version: 1\nforges:\n  gh:\n    type: github\n');
    seedMemberInto(doc, { section: 'sources', id: 'onprem' }, 'git');

    expect(doc.getIn(['forges', 'onprem', 'primary'])).toBeUndefined();
    expect(doc.getIn(['forges', 'gh', 'primary'])).toBeUndefined();
  });

  it('names no default for anything other than a provider', () => {
    const doc = loadDocument('version: 1\n');
    seedMemberInto(doc, { section: 'groups', id: 'engineering' }, '');

    expect(doc.getIn(['auth', 'default_provider'])).toBeUndefined();
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
    expect(() => loadInstanceConfig(noMail)).toRefuseWith('providers.magic-link-needs-mail');
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
    expect(out).toContain('# An ssh remote\n');

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

  it('puts the name alignment right after the header name, so it sits beside it', () => {
    const branding = buildSections(loadDocument(FULL)).find((s) => s.id === 'branding')!;
    const paths = branding.fields.map((f) => f.path);
    expect(paths.indexOf('brand.name_align')).toBe(paths.indexOf('brand.name') + 1);
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

  it('reads a host and a port as an address, not as an SSH remote', () => {
    expect(sshRemoteUrl('localhost:9000')).toBe('localhost:9000');
    expect(sshRemoteUrl('localhost:9000/api')).toBe('localhost:9000/api');
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
    expect(field?.value).toBe('••••••••');

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

  it('still hides a secret whose section is disabled', () => {
    expect(isDisabledSection('embedding')).toBe(true);
    const literal = FULL.replace(
      'api_key: ${TEST_ENTRA_CLIENT_SECRET}',
      'api_key: a-real-embedding-key',
    );
    const shown = displayYaml(literal);
    expect(shown).not.toContain('a-real-embedding-key');
    expect(shown).toContain(REDACTED);
  });
});

describe('a pick list', () => {
  const reposOf = (body: Record<string, unknown>) => {
    const doc = loadDocument(FULL);
    applyForm(doc, body, 'public');
    return doc.toJS().public?.repos as string[] | undefined;
  };

  it('keeps the list when the body carries none of its controls', () => {
    expect(reposOf({})).toEqual(['copetence/speicher-docs']);
  });

  it('adds the picked value once, after the kept ones', () => {
    expect(
      reposOf({
        'public.repos': 'copetence/speicher-docs',
        'add:public.repos': 'copetence/handbook',
      }),
    ).toEqual(['copetence/speicher-docs', 'copetence/handbook']);
    expect(
      reposOf({
        'public.repos': 'copetence/speicher-docs',
        'add:public.repos': 'copetence/speicher-docs',
      }),
    ).toEqual(['copetence/speicher-docs']);
  });

  it('writes an empty list when the last entry is removed', () => {
    expect(
      reposOf({
        'public.repos': 'copetence/speicher-docs',
        'remove:public.repos': 'copetence/speicher-docs',
        'add:public.repos': '',
      }),
    ).toEqual([]);
  });
});

describe('a disabled section', () => {
  const DISABLED = ['analytics', 'notifications', 'embedding'];

  it('has no page and no place in the column', () => {
    for (const id of DISABLED) {
      expect(isDisabledSection(id)).toBe(true);
      expect(isConfigSection(id)).toBe(false);
      expect(CONFIG_NAV_SECTIONS.map((entry) => entry.id)).not.toContain(id);
    }
  });

  it('is still built, so the secrets it names are still found', () => {
    const built = buildSections(loadDocument(FULL)).map((section) => section.id);
    for (const id of DISABLED) expect(built).toContain(id);
  });
});

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

describe('the mail transport page', () => {
  const mailFields = (yaml: string) =>
    allFields([buildSections(loadDocument(yaml)).find((s) => s.id === 'mail')!]);
  const field = (yaml: string, schemaPath: string) =>
    mailFields(yaml).find((f) => f.schemaPath === schemaPath)!;

  const UNSENT = `${FULL}\n`.replace('  from: Docs <docs@example.test>\n', '');

  it('marks only the host as required, which is all the schema requires', () => {
    expect(
      mailFields(FULL)
        .filter((f) => f.required)
        .map((f) => f.schemaPath),
    ).toEqual(['mail.host']);
  });

  it('offers a no-reply sender on the public host when the username is no address', () => {
    const from = withPublicUrl('https://docs.acme.example/', () => field(UNSENT, 'mail.from'));

    expect(from).toMatchObject({
      value: '',
      placeholder: 'Acme Engineering Docs <noreply@docs.acme.example>',
    });
  });

  it('offers the username as the sender when it is an address', () => {
    const yaml = UNSENT.replace('  username: docs\n', '  username: docs@acme.example\n');

    expect(field(yaml, 'mail.from')).toMatchObject({
      placeholder: 'Acme Engineering Docs <docs@acme.example>',
    });
  });
});

describe("a GitHub provider's addresses", () => {
  // A GitHub provider without an App shows the addresses for entering its App manually
  const NEW_PROVIDER = `${FULL}\n`.replace(
    '  providers:\n',
    '  providers:\n    octo:\n      type: github\n',
  );

  const copyValues = (id: string): CopyValueItem[] => {
    const section = buildSections(loadDocument(NEW_PROVIDER)).find((s) => s.id === id)!;
    return cardItems([section]).filter((item): item is CopyValueItem => item.kind === 'copy-value');
  };

  it('offers the homepage and the callback to copy, from the declared public URL', () => {
    const [homepage, callback] = withPublicUrl('https://docs.acme.example/', () =>
      copyValues('identity/octo'),
    );

    expect(homepage.text).toBe('https://docs.acme.example');
    expect(callback.text).toBe('https://docs.acme.example/api/auth/github/callback');
  });

  it('offers the path when no public URL is declared, for the browser to complete', () => {
    const [homepage, callback] = withPublicUrl(undefined, () => copyValues('identity/octo'));

    expect(homepage.text).toBe('/');
    expect(callback.text).toBe('/api/auth/github/callback');
  });

  it('offers the callback the sign-in actually sends, not a second spelling of it', () => {
    // The two are the same constant; GitHub refuses a redirect_uri that differs from
    // the registered one, and says nothing about which address it expected
    const [, callback] = withPublicUrl('https://docs.acme.example', () =>
      copyValues('identity/octo'),
    );

    expect(callback.text.endsWith(GITHUB_CALLBACK_PATH)).toBe(true);
  });

  it('places the callback beside the homepage', () => {
    const [homepage, callback] = copyValues('identity/octo');
    expect(homepage.startsRow).toBe(true);
    expect(callback.startsRow).toBe(false);
  });

  it('leaves the addresses out once the provider has an App', () => {
    // Only its directory App's webhook URL is left to copy
    expect(copyValues('identity/hub').map((value) => value.label)).toEqual([
      'Directory webhook URL',
    ]);
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
    expect(ssh.follows?.path).toBe('forges.onprem.repos.0.url');
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
    expect(webhook.text).toBe('https://docs.acme.example/-/hooks/forge/gh');
    expect(webhook.note).toContain('**Webhook URL**');
  });

  it('offers the path to copy when no public URL is declared, for the browser to complete', () => {
    const [webhook] = withPublicUrl(undefined, () => copyValues('sources/gh'));
    expect(webhook.text).toBe('/-/hooks/forge/gh');
    // One sentence for both: the browser completes the path, and without it the reader does
    expect(webhook.note).toContain('**Webhook URL**');
    expect(webhook.note).toContain('If only a path without a host is shown');
  });

  it('says nothing of the sort on a plain remote, which has no endpoint', () => {
    const values = withPublicUrl('https://docs.acme.example', () => copyValues('sources/onprem'));
    expect(values).toEqual([]);
  });
});

describe("a provider's sign-in routing", () => {
  const routing = (yaml: string, id: string) =>
    cardItems([sectionOf(loadDocument(yaml), `identity/${id}`)!]).find(
      (item): item is ChoiceItem =>
        item.kind === 'choice' && item.name === `choice:auth.providers.${id}.routing`,
    );

  it.each(['entra', 'hub'])('is offered on the page of %s', (id) => {
    expect(routing(FULL, id)).toBeDefined();
  });

  it('is for all email addresses while the provider names no domain', () => {
    expect(routing(FULL, 'hub')?.selected).toBe('everyone');
  });

  it('is for some domains once the provider names one', () => {
    const choice = routing(FULL, 'entra');
    expect(choice?.selected).toBe('domains');
    const [field] = fieldsOf(choice!.options.find((o) => o.value === 'domains')!.items);
    expect(field.path).toBe('auth.providers.entra.domains');
  });

  it('removes the domains when switched to all email addresses', () => {
    const doc = loadDocument(FULL);
    applyForm(doc, { 'choice:auth.providers.entra.routing': 'everyone' }, 'identity/entra');
    expect(loadInstanceConfig(serialise(doc)).raw.auth?.providers?.entra.domains).toBeUndefined();
  });

  it('keeps the domains when left on some domains', () => {
    const doc = loadDocument(FULL);
    applyForm(
      doc,
      {
        'choice:auth.providers.entra.routing': 'domains',
        'auth.providers.entra.domains': 'example.test\npartner.test',
      },
      'identity/entra',
    );
    expect(loadInstanceConfig(serialise(doc)).raw.auth?.providers?.entra.domains).toEqual([
      'example.test',
      'partner.test',
    ]);
  });
});

describe("a GitHub identity provider's App setup", () => {
  const NEW_PROVIDER = 'auth:\n  providers:\n    octo:\n      type: github\n';
  const items = (yaml: string, id: string) =>
    cardItems([sectionOf(loadDocument(yaml), `identity/${id}`)!]);

  it('offers to create a GitHub App, and says who will be able to sign in with it', () => {
    const shown = items(NEW_PROVIDER, 'octo');
    const [setup] = shown.filter((item): item is ChoiceItem => item.kind === 'choice');
    expect(setup.name).toBe('choice:auth.providers.octo.app');
    expect(setup.selected).toBe('create');

    const manifest = shown.find((item) => item.kind === 'github-app-manifest');
    expect(manifest).toMatchObject({ action: '/-/config/identity/octo/github-app/manifest' });
    expect(manifest && 'note' in manifest ? manifest.note : '').toContain('not an OAuth App');
  });

  it('shows only the client id and secret once the provider has them', () => {
    const shown = items(FULL, 'hub');
    expect(
      shown.some(
        (item) => item.kind === 'choice' && item.name !== 'choice:auth.providers.hub.routing',
      ),
    ).toBe(false);
    expect(
      shown.some((item) => 'path' in item && item.path === 'auth.providers.hub.client_id'),
    ).toBe(true);
  });

  const DIRECTORY = 'GitHub directory lookup (optional)';
  const directoryCard = (yaml: string, id: string) =>
    sectionOf(loadDocument(yaml), `identity/${id}`)!.cards.find(
      (card) => card.title === DIRECTORY,
    )!;

  it('hides the directory card until the App is entered manually', () => {
    expect(directoryCard(NEW_PROVIDER, 'octo')).toMatchObject({
      shownWith: 'choice:auth.providers.octo.app',
      shownWhen: 'manual',
      hidden: true,
    });
  });

  it('always shows the directory card once the provider has an App', () => {
    expect(directoryCard(FULL, 'hub').hidden).toBeUndefined();
  });

  it('asks for no directory kind, since filling in its App turns the lookup on', () => {
    const fields = allFields([sectionOf(loadDocument(FULL), 'identity/hub')!]);
    expect(fields.some((field) => field.path === 'auth.providers.hub.directory.type')).toBe(false);
  });

  it('keeps the session lifetime under advanced settings, and the default provider last', () => {
    const section = sectionOf(loadDocument(FULL), 'identity/hub')!;
    const field = (path: string) => section.fields.find((each) => each.path === path);
    expect(field('auth.providers.hub.session_ttl')?.advanced).toBe(true);
    expect(field('auth.default_provider')?.trailing).toBe(true);
    expect(section.cards.map((card) => card.title)).toEqual([
      'GitHub App',
      DIRECTORY,
      'Who should see this provider?',
    ]);
  });

  it('turns the GitHub directory on with its App, and removes it without one', () => {
    const directory = ['auth', 'providers', 'hub', 'directory'];
    const save = (body: Record<string, unknown>) => {
      const doc = loadDocument(FULL);
      applyForm(
        doc,
        { ...untouchedBody(allFields([sectionOf(doc, 'identity/hub')!])), ...body },
        'identity/hub',
      );
      return doc;
    };

    expect(save({}).getIn([...directory, 'type'])).toBe('github');

    const cleared = save({
      'auth.providers.hub.directory.app_id': '',
      'auth.providers.hub.directory.private_key': '',
    });
    expect(cleared.hasIn(directory)).toBe(false);
  });

  const directoryChoice = (yaml: string, id: string) =>
    directoryCard(yaml, id).items.find((item): item is ChoiceItem => item.kind === 'choice');

  it('offers to create the directory App once the provider has its App', () => {
    const yaml = 'auth:\n  providers:\n    octo:\n      type: github\n      client_id: Iv1.abc\n';
    const setup = directoryChoice(yaml, 'octo');
    expect(setup?.name).toBe('choice:auth.providers.octo.directory.app');
    expect(setup?.selected).toBe('create');
    const manifest = setup?.options[0].items[0];
    expect(manifest).toMatchObject({
      kind: 'github-app-manifest',
      action: '/-/config/identity/octo/github-directory-app/manifest',
      ownerName: 'github-directory-app:owner',
    });
  });

  it('offers the directory App on a new provider too, and none once it has a directory App', () => {
    expect(directoryChoice(NEW_PROVIDER, 'octo')?.selected).toBe('create');
    expect(directoryChoice(FULL, 'hub')).toBeUndefined();
  });

  const requiredPaths = (yaml: string, id: string) =>
    allFields([sectionOf(loadDocument(yaml), id)!])
      .filter((field) => field.required)
      .map((field) => field.path);

  it.each([
    ['assets:\n  driver: filesystem\n', ['assets.path']],
    ['assets:\n  driver: s3\n', ['assets.bucket', 'assets.region']],
    [
      'assets:\n  driver: azure\n  auth: key\n',
      ['assets.account', 'assets.container', 'assets.account_key'],
    ],
    [
      'assets:\n  driver: azure\n  auth: connection_string\n',
      ['assets.account', 'assets.container', 'assets.connection_string'],
    ],
    [
      'assets:\n  driver: azure\n  auth: managed_identity\n',
      ['assets.account', 'assets.container'],
    ],
  ])('marks what the driver needs as required for %j', (yaml, expected) => {
    expect(requiredPaths(yaml, 'storage')).toEqual(expected);
  });

  it('marks the fields of semantic retrieval that the schema requires', () => {
    expect(requiredPaths('', 'embedding')).toEqual([
      'embedding.base_url',
      'embedding.model',
      'embedding.dimensions',
    ]);
  });

  it('marks the App id and private key of a GitHub source as required', () => {
    const yaml = 'forges:\n  gh:\n    type: github\n    app_id: "1"\n';
    expect(requiredPaths(yaml, 'sources/gh')).toEqual([
      'forges.gh.app_id',
      'forges.gh.private_key',
    ]);
    const section = sectionOf(loadDocument(yaml), 'sources/gh')!;
    expect(section.cards.find((card) => card.title === 'GitHub App')?.required).toBe(true);
  });

  it('marks the GitHub App card and its client id and secret as required', () => {
    const section = sectionOf(loadDocument(FULL), 'identity/hub')!;
    expect(section.cards.find((card) => card.title === 'GitHub App')?.required).toBe(true);
    const required = allFields([section])
      .filter((field) => field.required)
      .map((field) => field.path);
    expect(required).toEqual(
      expect.arrayContaining([
        'auth.providers.hub.client_id',
        'auth.providers.hub.client_secret',
        'auth.providers.hub.directory.app_id',
        'auth.providers.hub.directory.private_key',
      ]),
    );
  });
});

describe("a GitHub source's App setup", () => {
  const NEW_SOURCE = 'forges:\n  gh:\n    type: github\n    default_repository_owner: copetence\n';

  const items = (yaml: string) => cardItems([sectionOf(loadDocument(yaml), 'sources/gh')!]);

  it('offers to create the App on GitHub while the source has none', () => {
    const [setup] = items(NEW_SOURCE).filter((item): item is ChoiceItem => item.kind === 'choice');
    expect(setup.name).toBe('choice:forges.gh.app');
    expect(setup.selected).toBe('create');
    expect(setup.follows).toBeUndefined();

    const manifest = items(NEW_SOURCE).find((item) => item.kind === 'github-app-manifest');
    expect(manifest).toMatchObject({
      action: '/-/config/sources/gh/github-app/manifest',
      owner: 'copetence',
    });
  });

  it('shows only the credentials once the source has an App', () => {
    const shown = items(FULL);
    expect(shown.some((item) => item.kind === 'choice')).toBe(false);
    expect(shown.some((item) => item.kind === 'github-app-manifest')).toBe(false);
  });

  const urlCardOf = (yaml: string) =>
    sectionOf(loadDocument(yaml), 'sources/gh')!.cards.find(
      (card) => card.title === 'Simpler URLs',
    )!;

  it('hides the Simpler URLs card until the App is entered manually', () => {
    expect(urlCardOf(NEW_SOURCE)).toMatchObject({
      shownWith: 'choice:forges.gh.app',
      shownWhen: 'manual',
      hidden: true,
    });
  });

  it('always shows the Simpler URLs card once the source has an App', () => {
    const card = urlCardOf(FULL);
    expect(card.shownWith).toBeUndefined();
    expect(card.hidden).toBeUndefined();
  });

  it('drops the credentials typed into the manual pane when the App is to be created', () => {
    const doc = loadDocument(NEW_SOURCE);
    applyForm(
      doc,
      {
        ...untouchedBody(allFields([sectionOf(doc, 'sources/gh')!])),
        'choice:forges.gh.app': 'create',
        'forges.gh.app_id': '12345',
      },
      'sources/gh',
    );
    expect(doc.getIn(['forges', 'gh', 'app_id'])).toBeUndefined();
  });

  it('keeps the credentials when they are entered manually', () => {
    const doc = loadDocument(NEW_SOURCE);
    applyForm(
      doc,
      {
        ...untouchedBody(allFields([sectionOf(doc, 'sources/gh')!])),
        'choice:forges.gh.app': 'manual',
        'forges.gh.app_id': '12345',
      },
      'sources/gh',
    );
    expect(doc.getIn(['forges', 'gh', 'app_id'])).toBe('12345');
  });
});

describe('the required fields of a plain remote', () => {
  const required = (repos: string): string[] => {
    const section = sectionOf(
      loadDocument(`forges:\n  onprem:\n    type: git\n    repos:\n${repos}`),
      'sources/onprem',
    );
    return (section ? allFields([section]) : [])
      .filter((field) => field.required)
      .map((field) => field.schemaPath);
  };

  it('marks the remote URL, the access token and the deploy key', () => {
    expect(required('      - id: docs\n        url: https://example.com/team/docs.git\n')).toEqual([
      'forges.<key>.repos.<index>.url',
      'forges.<key>.repos.<index>.token',
      'forges.<key>.repos.<index>.deploy_key',
    ]);
  });

  it('marks the known hosts once a repository uses ssh://', () => {
    const repos = '      - id: docs\n        url: ssh://git@example.com/team/docs.git\n';
    expect(required(repos)).toContain('forges.<key>.known_hosts');
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
