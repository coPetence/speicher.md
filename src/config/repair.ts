import type { ErrorObject } from 'ajv';
import type { Document } from 'yaml';
import { isMap } from 'yaml';

import { ConfigError } from '../common/errors';
import { parseStrictDocument } from '../common/yaml';
import { interpolateEnv } from './env-interpolation';
import { loadInstanceConfig } from './parser';
import { dropRetiredKeys } from './retired-keys';
import { validateInstanceSchema } from './schemas';
import type { InstanceConfig } from './types';

type Path = (string | number)[];

export interface RepairedConfig {
  yaml: string;
  removed: string[];
  remaining: string[];
}

const MAX_ROUNDS = 20;

/**
 * Removes every key and value the schema rejects, and checks whether the result loads
 *
 * @param yaml a stored instance config that does not load
 */
export function repairInstanceConfig(yaml: string): RepairedConfig {
  const { doc } = parseStrictDocument(yaml);
  const removed: string[] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const config = interpolated(doc);
    if (!config || validateInstanceSchema(config)) break;

    const paths = rejectedPaths(validateInstanceSchema.errors ?? [], config);
    if (paths.length === 0) break;
    for (const path of paths) {
      if (!doc.hasIn(path)) continue;
      doc.deleteIn(path);
      pruneEmptyParents(doc, path);
      removed.push(path.join('.'));
    }
  }

  const repaired = doc.toString({ lineWidth: 0 });
  try {
    loadInstanceConfig(repaired);
    return { yaml: repaired, removed, remaining: [] };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return {
      yaml: repaired,
      removed,
      remaining: err.problems.length > 0 ? err.problems : [err.message],
    };
  }
}

/** The document as the loader validates it, or null when its variables are not set */
function interpolated(doc: Document): InstanceConfig | null {
  try {
    const config = interpolateEnv(doc.toJS({ maxAliasCount: 0 }) as InstanceConfig);
    dropRetiredKeys(config);
    return config;
  } catch (err) {
    if (err instanceof ConfigError) return null;
    throw err;
  }
}

function rejectedPaths(errors: ErrorObject[], config: InstanceConfig): Path[] {
  const unknown = errors.filter((err) => err.keyword === 'additionalProperties');
  const chosen = unknown.length > 0 ? unknown : errors;

  const paths = chosen
    .map((err) => {
      const path = pathOf(err.instancePath, config);
      if (err.keyword !== 'additionalProperties') return path;
      return [...path, (err.params as { additionalProperty: string }).additionalProperty];
    })
    .filter((path) => path.length > 0);

  const keys = new Set(paths.map((path) => path.join('\u0000')));
  return paths.filter((path, index) => {
    const key = path.join('\u0000');
    if (paths.findIndex((other) => other.join('\u0000') === key) !== index) return false;
    return !path.some((_, end) => end > 0 && keys.has(path.slice(0, end).join('\u0000')));
  });
}

function pathOf(pointer: string, config: InstanceConfig): Path {
  const path: Path = [];
  let at: unknown = config;
  for (const raw of pointer.split('/').slice(1)) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    const key = Array.isArray(at) ? Number(part) : part;
    path.push(key);
    at = (at as Record<string | number, unknown> | undefined)?.[key];
  }
  return path;
}

function pruneEmptyParents(doc: Document, path: Path): void {
  for (let end = path.length - 1; end > 0; end--) {
    const parent = path.slice(0, end);
    const node = doc.getIn(parent, true);
    if (!isMap(node) || node.items.length > 0) return;
    doc.deleteIn(parent);
  }
}
