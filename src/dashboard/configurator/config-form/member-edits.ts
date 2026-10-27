import { Document, isMap, isSeq } from 'yaml';

import { Path, renameMapKey, setNodeAt, writeAt } from './document';
import { MemberRef, memberPath, seedMember } from './members';

export function memberExists(doc: Document, ref: MemberRef): boolean {
  return doc.getIn(memberPath(ref)) !== undefined;
}

export function seedMemberInto(doc: Document, ref: MemberRef, kind: string): void {
  // Persist the first provider's default role and first source's primary role
  // so adding members preserves these roles and source URLs
  const first = ref.section in FIRST_MEMBER_ROLE && !hasMembers(doc, memberPath(ref).slice(0, -1));
  setNodeAt(doc, memberPath(ref), seedMember(ref, kind));
  if (!first) return;

  if (ref.section === 'identity' && doc.getIn(['auth', 'default_provider']) === undefined) {
    writeAt(doc, ['auth', 'default_provider'], ref.id);
  }
  if (ref.section === 'sources') writeAt(doc, [...memberPath(ref), 'primary'], true);
}

// Sections with a special role for the first member
const FIRST_MEMBER_ROLE: Record<string, true> = { identity: true, sources: true };

function hasMembers(doc: Document, path: Path): boolean {
  const members = doc.getIn(path, true);
  return isMap(members) && members.items.length > 0;
}

export function renameMember(doc: Document, section: string, from: string, to: string): boolean {
  if (section === 'identity') return renameProvider(doc, from, to);
  if (section === 'groups') return renameGroup(doc, from, to);
  return false;
}

function renameGroup(doc: Document, from: string, to: string): boolean {
  if (from === to) return false;
  if (!renameMapKey(doc, ['groups'], from, to)) return false;

  const admins = doc.getIn(['admins', 'groups'], true);
  if (isSeq(admins)) {
    admins.items.forEach((_, index) => {
      if (doc.getIn(['admins', 'groups', index]) === from) {
        writeAt(doc, ['admins', 'groups', index], to);
      }
    });
  }

  forEachGroupItem(doc, (name, index) => {
    if (doc.getIn(['groups', name, index, 'group']) === from) {
      writeAt(doc, ['groups', name, index, 'group'], to);
    }
  });

  return true;
}

/** Every position of every group's list, as the group's name and the position */
function forEachGroupItem(doc: Document, visit: (name: string, index: number) => void): void {
  const groups = doc.getIn(['groups'], true);
  if (!isMap(groups)) return;
  for (const item of groups.items) {
    const name = keyOf(item.key);
    if (name === null) continue;
    const items = doc.getIn(['groups', name], true);
    if (!isSeq(items)) continue;
    items.items.forEach((_, index) => visit(name, index));
  }
}

function renameProvider(doc: Document, from: string, to: string): boolean {
  if (from === to) return false;
  if (!renameMapKey(doc, ['auth', 'providers'], from, to)) return false;

  if (doc.getIn(['auth', 'default_provider']) === from) {
    writeAt(doc, ['auth', 'default_provider'], to);
  }

  forEachGroupItem(doc, (name, index) => {
    if (doc.getIn(['groups', name, index, 'provider']) === from) {
      writeAt(doc, ['groups', name, index, 'provider'], to);
    }
  });

  const admins = doc.getIn(['admins', 'users'], true);
  if (isSeq(admins)) {
    admins.items.forEach((_, index) => {
      if (doc.getIn(['admins', 'users', index, 'provider']) === from) {
        writeAt(doc, ['admins', 'users', index, 'provider'], to);
      }
    });
  }

  return true;
}

/** A map item's key, in either of the two shapes a key comes in. */
function keyOf(key: unknown): string | null {
  if (typeof key === 'string') return key;
  const value = (key as { value?: unknown } | null)?.value;
  return typeof value === 'string' ? value : null;
}
