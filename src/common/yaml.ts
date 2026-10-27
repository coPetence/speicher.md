/**
 * YAML 1.2 core schema keeps yes/no as strings
 * Anchors, aliases, and merge keys are forbidden
 */

import { Document, parseDocument, visit, isAlias, isNode, isScalar, LineCounter } from 'yaml';

import { CodedError } from './errors';

export interface YamlParseResult<T = unknown> {
  value: T;

  lineOf(keyPath: string): number | null;
}

/** Syntax errors and forbidden YAML features */
export type YamlCode = 'yaml.syntax' | 'yaml.alias' | 'yaml.anchor' | 'yaml.merge-key';

export class YamlError extends CodedError<YamlCode> {
  readonly line: number | null;

  constructor(code: YamlCode, message: string, line: number | null) {
    super(code, line === null ? message : `line ${line}: ${message}`);
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
    throw new YamlError('yaml.syntax', first.message, first.linePos?.[0]?.line ?? null);
  }

  const lineAt = (offset: number | undefined) =>
    typeof offset === 'number' ? lineCounter.linePos(offset).line : null;

  visit(doc, (_key, node) => {
    if (isAlias(node)) {
      throw new YamlError(
        'yaml.alias',
        `alias "*${node.source}" is not permitted`,
        lineAt(node.range?.[0]),
      );
    }
    if (isNode(node) && node.anchor) {
      throw new YamlError(
        'yaml.anchor',
        `anchor "&${node.anchor}" is not permitted`,
        lineAt(node.range?.[0]),
      );
    }
    if (isScalar(node) && typeof node.value === 'string' && node.value === '<<') {
      throw new YamlError(
        'yaml.merge-key',
        'merge key "<<" is not permitted',
        lineAt(node.range?.[0]),
      );
    }
  });

  return { doc, lineAt };
}

/**
 * Parse strict YAML into a JS value with key-path line lookup
 * maxAliasCount: 0 adds a fallback check against aliases
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
