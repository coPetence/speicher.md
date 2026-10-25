/**
 * The logical structure of a group
 */
import { isExpired } from '../common/until';
import { GroupItem, GroupReference, GroupSource, InstanceConfig, isGroupReference } from './types';

export type GroupCondition =
  | { kind: 'any'; items: GroupCondition[] }
  | { kind: 'source'; source: GroupSource }
  | { kind: 'reference'; reference: GroupReference };

/** The condition one group's list spells */
export function conditionOf(items: GroupItem[]): GroupCondition {
  return {
    kind: 'any',
    items: items.map((item) =>
      isGroupReference(item)
        ? { kind: 'reference', reference: item }
        : { kind: 'source', source: item },
    ),
  };
}

/** The groups the list names directly, in order and without repeats */
export function referencesOf(items: GroupItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (isGroupReference(item) && !out.includes(item.group)) out.push(item.group);
  }
  return out;
}

/** The sources of the list itself, references left out */
export function sourcesOf(items: GroupItem[]): GroupSource[] {
  return items.filter((item): item is GroupSource => !isGroupReference(item));
}

/**
 * Every source the list has directly or through references, in order and without repeats
 *
 * @param groups the groups map of the config
 * @param name the group
 * @param now the moment `until` is judged against
 */
export function leavesOf(
  groups: Record<string, GroupItem[]> | undefined,
  name: string,
  now: Date = new Date(),
): GroupSource[] {
  const out: GroupSource[] = [];
  const visited = new Set<string>();
  const walk = (group: string): void => {
    if (visited.has(group)) return;
    visited.add(group);
    for (const item of groups?.[group] ?? []) {
      if (isExpired(item.until, now)) continue;
      if (isGroupReference(item)) walk(item.group);
      else if (!out.includes(item)) out.push(item);
    }
  };
  walk(name);
  return out;
}

export function hasAnySource(
  groups: Record<string, GroupItem[]> | undefined,
  name: string,
): boolean {
  const visited = new Set<string>();
  const walk = (group: string): boolean => {
    if (visited.has(group)) return false;
    visited.add(group);
    return (groups?.[group] ?? []).some((item) =>
      isGroupReference(item) ? walk(item.group) : true,
    );
  };
  return walk(name);
}

export function referrersOf(
  groups: Record<string, GroupItem[]> | undefined,
  name: string,
): string[] {
  const out: string[] = [];
  const pending = [name];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const [other, items] of Object.entries(groups ?? {})) {
      if (other === name || out.includes(other)) continue;
      if (referencesOf(items).includes(current)) {
        out.push(other);
        pending.push(other);
      }
    }
  }
  return out.sort();
}

export function referenceCycle(groups: Record<string, GroupItem[]> | undefined): string[] | null {
  const done = new Set<string>();
  const path: string[] = [];
  const onPath = new Set<string>();

  const visit = (name: string): string[] | null => {
    if (onPath.has(name)) return [...path.slice(path.indexOf(name)), name];
    if (done.has(name)) return null;
    onPath.add(name);
    path.push(name);
    for (const next of referencesOf(groups?.[name] ?? [])) {
      // A reference to a group that does not exist is another check's problem
      if (!Object.prototype.hasOwnProperty.call(groups ?? {}, next)) continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    onPath.delete(name);
    done.add(name);
    return null;
  };

  for (const name of Object.keys(groups ?? {})) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
}

export function evaluate(
  condition: GroupCondition,
  now: Date,
  matchesSource: (source: GroupSource) => boolean,
  member: (group: string) => boolean,
): boolean {
  switch (condition.kind) {
    case 'any':
      return condition.items.some((item) => evaluate(item, now, matchesSource, member));
    case 'source':
      return !isExpired(condition.source.until, now) && matchesSource(condition.source);
    case 'reference':
      return !isExpired(condition.reference.until, now) && member(condition.reference.group);
  }
}

export function membersOf(
  config: Pick<InstanceConfig, 'groups'>,
  now: Date,
  matchesSource: (source: GroupSource) => boolean,
): string[] {
  const groups = config.groups ?? {};
  const memo = new Map<string, boolean>();
  const member = (name: string): boolean => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    // Written before the walk, so a cycle that slipped past the check reads as
    // "not a member" rather than recursing without end
    memo.set(name, false);
    const items = groups[name];
    const result = items !== undefined && evaluate(conditionOf(items), now, matchesSource, member);
    memo.set(name, result);
    return result;
  };
  return Object.keys(groups)
    .filter((name) => member(name))
    .sort();
}
