import { Document } from 'yaml';

import { referencesOf, referrersOf } from '../../../../config/groups';
import type { GroupItem } from '../../../../config/types';
import { GROUP_ADD, ROW_KINDS, RowKind } from '../collections';
import { appendSeqItem, dottedPath, parseLines, removeAt, setNodeAt, writeAt } from '../document';
import { FormSection, allFields, allOps } from '../model';
import { seedForge } from '../members';
import { FormBody, submitted, submittedList } from './body';

export interface OpResult {
  structural: boolean;
  changed: boolean;
}

const NOTHING: OpResult = { structural: false, changed: false };

export function applyOp(
  doc: Document,
  body: FormBody,
  op: string,
  rebuilt: FormSection | undefined,
): OpResult {
  const offered = new Set(rebuilt ? allOps([rebuilt]) : []);
  if (!offered.has(op) && !offered.has(op.replace(/\.\d+$/, ''))) {
    return NOTHING;
  }

  const verb = op.slice(0, op.indexOf(':'));

  if (verb === 'remove-selected') {
    const selected = submittedList(body, 'select').filter((each) => offered.has(each));
    for (const each of selected.sort(byDescendingPosition)) applyStructural(doc, body, each);
    return { structural: true, changed: selected.length > 0 };
  }

  if (verb === 'reset') {
    const cleared = resetSection(doc, rebuilt);
    return { structural: true, changed: cleared };
  }

  if (verb !== 'add' && verb !== 'remove') return NOTHING;

  applyStructural(doc, body, op);
  return { structural: true, changed: true };
}

function resetSection(doc: Document, section: FormSection | undefined): boolean {
  let changed = false;
  for (const field of section ? allFields([section]) : []) {
    if (writeAt(doc, dottedPath(field.path), undefined)) changed = true;
  }
  return changed;
}

function byDescendingPosition(a: string, b: string): number {
  const at = (op: string) => Number(/\.(\d+)$/.exec(op)?.[1] ?? -1);
  return at(b) - at(a);
}

function applyStructural(doc: Document, body: FormBody, op: string): void {
  const [verb, target] = [op.slice(0, op.indexOf(':')), op.slice(op.indexOf(':') + 1)];
  const path = dottedPath(target);

  if (verb === 'remove') {
    removeAt(doc, path);
    return;
  }

  const scoped = GROUP_ADD.exec(target);
  if (scoped) {
    appendGroupItem(doc, body, scoped[1].slice('groups.'.length), target);
    return;
  }

  const name = (submitted(body, `newname:${target}`) ?? '').trim();
  const type = (submitted(body, `newtype:${target}`) ?? '').trim();

  switch (target) {
    case 'auth.providers': {
      if (name === '') return;
      setNodeAt(doc, [...path, name], type === 'oidc' || type === '' ? { type: 'oidc' } : { type });
      return;
    }
    case 'groups': {
      if (name === '') return;
      setNodeAt(doc, [...path, name], []);
      return;
    }
    case 'forges': {
      if (name === '') return;
      setNodeAt(doc, [...path, name], seedForge(type));
      return;
    }
    case 'admins.users': {
      appendSeqItem(doc, path, {});
      return;
    }
    default: {
      if (/^forges\.[^.]+\.repos$/.test(target)) {
        appendSeqItem(doc, path, {});
      }
    }
  }
}

function appendGroupItem(doc: Document, body: FormBody, name: string, target: string): void {
  const kind = (submitted(body, `newkind:${target}`) ?? '').trim();
  if (!(ROW_KINDS as readonly string[]).includes(kind)) return;

  if (kind === 'reference') {
    const groups = (doc.getIn(['groups']) as { toJSON(): Record<string, GroupItem[]> })?.toJSON();
    // Neither a second row for a group already named, nor one that closes a cycle
    const taken = [...referencesOf(groups?.[name] ?? []), ...referrersOf(groups, name)];
    for (const chosen of submittedList(body, `newname:${target}.${kind}`)) {
      const group = chosen.trim();
      if (group === '' || group === name || doc.getIn(['groups', group]) === undefined) continue;
      if (taken.includes(group)) continue;
      appendSeqItem(doc, ['groups', name], { group });
      taken.push(group);
    }
    return;
  }

  const chosen = (submitted(body, `newname:${target}.${kind}`) ?? '').trim();
  if (chosen === '') return;

  const provider = doc.getIn(['auth', 'providers', chosen]);
  if (provider === undefined) return;
  const magicLink = doc.getIn(['auth', 'providers', chosen, 'type']) === 'magic-link';
  const key = matchKeyOf(kind as RowKind, magicLink);
  if (key === null) return;

  const matches = parseLines(submitted(body, `newmatches:${target}.${kind}`) ?? '');
  for (const match of matches.length > 0 ? matches : ['']) {
    appendSeqItem(doc, ['groups', name], { provider: chosen, [key]: match });
  }
}

function matchKeyOf(kind: RowKind, magicLink: boolean): 'id' | 'domain' | 'email' | null {
  switch (kind) {
    case 'group':
      return magicLink ? null : 'id';
    case 'domain':
      return magicLink ? 'domain' : null;
    case 'person':
      return 'email';
    default:
      return null;
  }
}
