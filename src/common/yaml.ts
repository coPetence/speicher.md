/**
 * YAML 1.2 core schema, no anchors, aliases, or merge keys
 *
 * The `yaml` library defaults to YAML 1.1 which coerces `yes`/`no` to booleans
 * Locking to 1.2 core schema avoids that
 * Anchors and aliases are forbidden because the resolved graph, not the raw tree,
 *   determines validity and schema alone cannot catch every misuse
 * Merge keys are resolved into aliases by the library, so they are also excluded
 */

import { Document, parseDocument, visit, isAlias, isNode, isScalar, LineCounter } from 'yaml';

export interface YamlParseResult<T = unknown> {
  value: T;

  lineOf(keyPath: string): number | null;
}

export class YamlError extends Error {
  readonly line: number | null;

  constructor(message: string, line: number | null) {
    super(line === null ? message : `line ${line}: ${message}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

export function parseStrictDocument(source: string): {
  doc: Document.Parsed;
  lineAt(offset: number | undefined): number | null;
} {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, {
    version: '1.2',
    schema: 'core',
    merge: false,
    lineCounter,

    uniqueKeys: true,
  });

  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    throw new YamlError(first.message, first.linePos?.[0]?.line ?? null);
  }

  const lineAt = (offset: number | undefined) =>
    typeof offset === 'number' ? lineCounter.linePos(offset).line : null;

  visit(doc, (_key, node) => {
    if (isAlias(node)) {
      throw new YamlError(`alias "*${node.source}" is not permitted`, lineAt(node.range?.[0]));
    }
    if (isNode(node) && node.anchor) {
      throw new YamlError(`anchor "&${node.anchor}" is not permitted`, lineAt(node.range?.[0]));
    }
    if (isScalar(node) && typeof node.value === 'string' && node.value === '<<') {
      throw new YamlError('merge key "<<" is not permitted', lineAt(node.range?.[0]));
    }
  });

  return { doc, lineAt };
}

/**
 * Parse and throw on any error, anchor, alias or merge key
 *
 * Returns a plain JS value via `doc.toJS()` which throws on unresolved aliases
 *   (`maxAliasCount: 0`) as a safety net in case the pre-emptive visit misses one
 */

export function parseStrictYaml<T = unknown>(source: string): YamlParseResult<T> {
  const { doc, lineAt } = parseStrictDocument(source);
  return {
    value: doc.toJS({ maxAliasCount: 0 }) as T,
    lineOf(keyPath: string) {
      const parts = keyPath.split('.').filter(Boolean);
      const node = doc.getIn(parts, true);
      if (!isNode(node)) return null;
      return lineAt(node.range?.[0]);
    },
  };
}
