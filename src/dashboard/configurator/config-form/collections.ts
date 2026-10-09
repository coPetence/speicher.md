/**
 * Config form collection tracking
 *
 * Growable collections communicate their shape through hidden form inputs so
 * the backend can detect additions, removals and renames
 *
 * Each map sends its keys as a comma-separated string, each list its length,
 * typed sequences send comma-separated kinds
 *
 * Reshapable fields send their rendered value; the backend compares it
 * against submitted `__was:` to decide whether to re-render the section
 */

import { Document, isMap, isSeq } from 'yaml';

import type { SelectField } from './config-fields';
import { FormSection, allFields, allOps } from './model';

export const SHAPE_PREFIX = '__shape:' as const; // Prefix for hidden fields carrying collection shape

export const RENDERED_PREFIX = '__was:' as const; // Prior rendered value of a reshapable field

/** Extracts a string key from a YAML map key node */
function keyOf(key: unknown): string | null {
  if (typeof key === 'string') return key;
  const value = (key as { value?: unknown } | null)?.value;
  return typeof value === 'string' ? value : null;
}

/**
 * Metadata for a growable config collection
 */
export interface Collection {
  path: string;
  kind: 'map' | 'list';

  keys: string[];

  length: number;

  seed?: unknown; // Default item for add operations without a kind

  kinds?: string[];

  seedOf?: Record<string, unknown>; // Seeds per kind for typed sequences
}

/**
 * Whether the node at a path is a person source or a group source
 *
 * Not a map or a map without `subject` or `email` is a group
 */
export function sourceKindAt(doc: Document, path: (string | number)[]): string {
  const node = doc.getIn(path, true);
  if (!isMap(node)) return SOURCE_GROUP;
  return node.has('subject') || node.has('email') ? SOURCE_PERSON : SOURCE_GROUP;
}

export const SOURCE_GROUP = 'group';

export const SOURCE_PERSON = 'person';

/**
 * Enumerates all growable collections in a config document
 *
 * Paths are hardcoded to the known schema: auth.providers, groups,
 * admins.users, forges, and repos per git forge
 */
export function collectionsOf(doc: Document): Collection[] {
  const out: Collection[] = [];

  const mapKeys = (path: (string | number)[]): string[] => {
    const node = doc.getIn(path, true);
    if (!isMap(node)) return [];
    return node.items.map((item) => keyOf(item.key)).filter((key): key is string => key !== null);
  };

  const seqLength = (path: (string | number)[]): number => {
    const node = doc.getIn(path, true);
    return isSeq(node) ? node.items.length : 0;
  };

  const seqKinds = (path: (string | number)[]): string[] => {
    const node = doc.getIn(path, true);
    if (!isSeq(node)) return [];
    return node.items.map((_, index) => sourceKindAt(doc, [...path, index]));
  };

  const map = (path: string) => {
    out.push({ path, kind: 'map', keys: mapKeys(path.split('.')), length: 0 });
  };
  const list = (path: string) => {
    out.push({ path, kind: 'list', keys: [], length: seqLength(path.split('.')) });
  };

  map('auth.providers');

  map('groups');
  for (const name of mapKeys(['groups'])) {
    // Each group entry is a list of sources (people or providers)
    const path = `groups.${name}`;
    out.push({
      path,
      kind: 'list',
      keys: [],
      length: seqLength(path.split('.')),
      kinds: seqKinds(path.split('.')),
    });
  }

  list('admins.users');

  map('forges');
  for (const id of mapKeys(['forges'])) {
    // Only git forges have a repos list
    if (doc.getIn(['forges', id, 'type']) === 'git') list(`forges.${id}.repos`);
  }

  return out;
}

/** Serialises a collection's shape as a comma-separated string */
export function shapeValue(collection: Collection): string {
  if (collection.kinds) return collection.kinds.join(',');
  return collection.kind === 'map' ? collection.keys.join(',') : String(collection.length);
}

export interface ShapeControl {
  name: string;
  value: string;
}

/**
 * Parses an add operation into path, kind and seed
 *
 * The scoped form `groups.<name>.provider|person.<id>` sets kind and
 * seed from the provider; the unscoped form only sets the path
 */
export function addTarget(op: string): { path: string; kind?: string; seed?: unknown } {
  const target = op.startsWith('add:') ? op.slice('add:'.length) : op;
  // Matches `groups.<name>.provider.<id>` or `groups.<name>.person.<id>`
  //  Group 1: group path
  //  Group 2: `provider` or `person`
  //  Group 3: provider id
  const scoped = /^(groups\.[^.]+)\.(provider|person)\.(.+)$/.exec(target);
  if (!scoped) return { path: target };

  const [, path, verb, provider] = scoped;
  // Person seeds carry an empty email as the default
  return verb === 'person'
    ? { path, kind: SOURCE_PERSON, seed: { provider, email: '' } }
    : { path, kind: SOURCE_GROUP, seed: { provider } };
}

/** Collections growable through add operations in the section */
export function collectionsIn(doc: Document, section: FormSection): Collection[] {
  const growable = new Map<string, { seed?: unknown; seedOf: Record<string, unknown> }>();
  for (const op of allOps([section])) {
    if (!op.startsWith('add:')) continue;
    const { path, kind, seed } = addTarget(op);
    const entry = growable.get(path) ?? { seedOf: {} };
    // An unkinded add sets the single seed; a kinded one populates seedOf
    if (kind === undefined) entry.seed = seed;
    else entry.seedOf[kind] = seed;
    growable.set(path, entry);
  }
  return collectionsOf(doc)
    .filter((collection) => growable.has(collection.path))
    .map((collection) => ({ ...collection, ...growable.get(collection.path) }));
}

/** Hidden form controls for collection shape and reshapable field values */
export function shapeControls(doc: Document, section: FormSection): ShapeControl[] {
  return [
    ...collectionsIn(doc, section).map((collection) => ({
      name: `${SHAPE_PREFIX}${collection.path}`,
      value: shapeValue(collection),
    })),
    ...reshapingFields(section).map((field) => ({
      name: `${RENDERED_PREFIX}${field.path}`,
      value: showing(field),
    })),
  ];
}

// The selects whose choice decides which other fields the page has
function reshapingFields(section: FormSection): SelectField[] {
  return allFields([section]).filter(
    (field): field is SelectField => field.kind === 'select' && field.reshapes,
  );
}

function showing(field: SelectField): string {
  return field.value || (field.fallback ?? '');
}

/** Whether a reshapable field changed since the last render */
export function reshaped(section: FormSection, body: Record<string, unknown>): boolean {
  return reshapingFields(section).some((field) => {
    const was = body[`${RENDERED_PREFIX}${field.path}`];
    return typeof was === 'string' && was !== showing(field);
  });
}

/** Parses submitted comma-separated keys for a map collection, null when absent */
export function submittedKeys(body: Record<string, unknown>, path: string): string[] | null {
  const raw = body[`${SHAPE_PREFIX}${path}`];
  if (typeof raw !== 'string') return null;
  return raw
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

/** Parses submitted length for a list collection, null when absent */
export function submittedLength(body: Record<string, unknown>, path: string): number | null {
  const raw = body[`${SHAPE_PREFIX}${path}`];
  if (typeof raw !== 'string') return null;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Parses submitted comma-separated kinds for a typed sequence, null when absent */
export function submittedKinds(body: Record<string, unknown>, path: string): string[] | null {
  const raw = body[`${SHAPE_PREFIX}${path}`];
  if (typeof raw !== 'string') return null;
  return raw
    .split(',')
    .map((kind) => kind.trim())
    .filter((kind) => kind.length > 0);
}
