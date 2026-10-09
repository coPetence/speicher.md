import { Logger, rootLogger } from '../common/logger';
import { InstanceConfig } from './types';

const log: Logger = rootLogger.child('config');

/** One key the schema has stopped accepting */
interface RetiredKey {
  /** Where it lived. `*` stands for every key of the map at that position */
  path: string[];
  /** What to do instead, said to whoever still has it in their document */
  note: string;
}

const RETIRED: RetiredKey[] = [
  {
    path: ['auth', 'providers', '*', 'team_cache_ttl'],
    note: 'team cache was replaced by `session_ttl`',
  },
];

export function dropRetiredKeys(config: InstanceConfig): string[] {
  const dropped: string[] = [];

  for (const retired of RETIRED) {
    for (const found of remove(config as unknown as Container, retired.path)) {
      dropped.push(found);
      log.warn(`\`${found}\` is no longer a configuration key and was ignored; ${retired.note}`);
    }
  }
  return dropped;
}

type Container = Record<string, unknown>;

function remove(node: unknown, path: string[], seen: string[] = []): string[] {
  if (!isContainer(node)) return [];

  const [head, ...rest] = path;
  const keys = head === '*' ? Object.keys(node) : [head];

  const dropped: string[] = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;

    if (rest.length === 0) {
      delete node[key];
      dropped.push([...seen, key].join('.'));
      continue;
    }
    dropped.push(...remove(node[key], rest, [...seen, key]));
  }
  return dropped;
}

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
