/**
 * YAML document manipulation for the admin config form
 *
 * The tree is a yaml `Document.Parsed` parsed with schema-typed field validation
 * `writeAt` clears a value by deleting the key rather than storing null/empty
 * `writeAtWithDefault` skips writing when the value equals the fallback and the
 * key is absent, so the default renders in the UI without being persisted
 *
 * Not using `doc.setIn` directly because it does not prune empty ancestors
 */

import { Document, isMap, isNode, isSeq, YAMLSeq } from 'yaml';

import { parseStrictDocument } from '../../../common/yaml';

export type Path = (string | number)[];

/**
 * A field's dotted path as a document path. An all-digit segment is a position in
 * a sequence, which is why `groups.eng.2` and a provider called `2` need the
 * literal segment `applyStructural` puts between them.
 */
export function dottedPath(dotted: string): Path {
  return dotted.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

export function loadDocument(yaml: string): Document.Parsed {
  return parseStrictDocument(yaml).doc;
}

export function serialise(doc: Document): string {
  // lineWidth: 0 disables wrapping; YAML is generated per-field and must be stable
  return doc.toString({ lineWidth: 0 });
}

export function hasAt(doc: Document, path: Path): boolean {
  return doc.hasIn(path);
}

function currentValue(doc: Document, path: Path): unknown {
  const node = doc.getIn(path, true);
  if (node === undefined) return undefined;
  return isNode(node) ? (node.toJSON() as unknown) : node;
}

// JSON stringify comparison so plain objects and numbers match their YAML
// round-trip representation
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function writeAt(doc: Document, path: Path, value: unknown): boolean {
  if (value === undefined || value === null || value === '') {
    if (!doc.hasIn(path)) return false;
    doc.deleteIn(path);
    pruneEmptyParents(doc, path);
    return true;
  }
  // Not updating if the value is identical so the caller can detect no-ops
  if (doc.hasIn(path) && sameValue(currentValue(doc, path), value)) return false;
  // YAMLSeq would be dropped by createNode; arrays are passed through so seq
  // items survive
  doc.setIn(path, Array.isArray(value) ? doc.createNode(value) : value);
  return true;
}

export function writeAtWithDefault(
  doc: Document,
  path: Path,
  value: unknown,
  fallback: unknown,
): boolean {
  if (value === fallback && !doc.hasIn(path)) return false;
  return writeAt(doc, path, value);
}

function pruneEmptyParents(doc: Document, path: Path): void {
  for (let i = path.length - 1; i > 0; i--) {
    const parent = path.slice(0, i);
    const node = doc.getIn(parent, true);
    // Stop at the first parent that is not an empty map
    if (!isMap(node) || node.items.length > 0) return;
    doc.deleteIn(parent);
  }
}

export function ensureSequence(doc: Document, path: Path): void {
  const node = doc.getIn(path, true);
  if (isSeq(node)) return;
  doc.setIn(path, new YAMLSeq());
}

export function removeAt(doc: Document, path: Path): void {
  doc.deleteIn(path);
}

export function setNodeAt(doc: Document, path: Path, value: unknown): void {
  doc.setIn(path, doc.createNode(value));
}

export function appendSeqItem(doc: Document, path: Path, value: unknown): void {
  ensureSequence(doc, path);
  const node = doc.getIn(path, true) as YAMLSeq;
  node.add(doc.createNode(value));
}

export function renameMapKey(doc: Document, at: Path, from: string, to: string): boolean {
  const map = doc.getIn(at, true);
  if (!isMap(map)) return false;
  // Bail if the source key is missing or the target key already exists
  const item = map.items.find((entry) => keyText(entry.key) === from);
  if (!item || map.items.some((entry) => keyText(entry.key) === to)) return false;
  // YAML AST nodes store the key text in `.value`
  if (isNode(item.key)) (item.key as { value: unknown }).value = to;
  else item.key = to;
  return true;
}

function keyText(key: unknown): string | null {
  if (typeof key === 'string') return key;
  const value = (key as { value?: unknown } | null)?.value;
  return typeof value === 'string' ? value : null;
}

export function scalarString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function linesOf(value: unknown): string {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : '';
  return value.map((v) => scalarString(v)).join('\n');
}

export function parseLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
