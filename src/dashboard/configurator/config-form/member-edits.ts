import { Document, isMap, isSeq } from 'yaml';

import { renameMapKey, setNodeAt, writeAt } from './document';
import { MemberRef, memberPath, seedMember } from './members';

/**
 * Edits to a document that are about a member as a whole — whether it exists,
 * bringing it into existence, and giving it a different key — rather than about
 * any one of its values, which is what `decode/` does.
 */

/** Whether the document already has the member a page is about. */
export function memberExists(doc: Document, ref: MemberRef): boolean {
  return doc.getIn(memberPath(ref)) !== undefined;
}

/**
 * Bring the member a page is about into existence, in the document it belongs to.
 *
 * `setNodeAt` rather than `setIn` with a plain object — see the note on that
 * function: a plain array survives serialising and then fails on the first write
 * *into* it. A group is seeded as an empty list, which loads: a group with no
 * item makes nobody a member, so nothing has to be typed before the name can be
 * saved, and its rows are added on its own page.
 */
export function seedMemberInto(doc: Document, ref: MemberRef, kind: string): void {
  setNodeAt(doc, memberPath(ref), seedMember(ref, kind));
}

/**
 * Give a member a different key, everywhere this document says it.
 *
 * One entry point, because renaming is one operation to an operator and the route
 * that offers it should not carry a switch over what this file happens to support.
 * The reference-rewriting itself stays hand-written per collection: what names a
 * provider and what names a group are different lists, and a generic walk looking
 * for a matching string would rename a group called `entra` because a provider is.
 */
export function renameMember(doc: Document, section: string, from: string, to: string): boolean {
  if (section === 'identity') return renameProvider(doc, from, to);
  if (section === 'groups') return renameGroup(doc, from, to);
  return false;
}

/**
 * Rename a group, and the two other places in this document that name it.
 *
 * `admins.groups` is one, and it is the one that matters most: a dangling entry
 * there is not a group that grants nothing, it is an administrator block that
 * resolves to fewer people. A `group:` item on another group's list is the other,
 * and a dangling one there is a group that lost members. The loader refuses a
 * document naming a group the map does not define in either place, so a missed
 * reference cannot be stored.
 *
 * What this cannot reach is every `access:` block in every repository, which name
 * groups by exactly this name and are not this instance's documents to edit. Such
 * a grant stops matching at the next sync and is reported to its author — it fails
 * closed and visibly, which is the good version of this going wrong, and the page
 * says so before the button.
 */
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

/**
 * Give a provider a different short id, everywhere this document says it.
 *
 * Four places, and the three that are not the key are the ones that matter: a
 * dangling `provider` is a grant that resolves to nobody, and access failing
 * closed is the quiet failure. `renameMapKey` explains why the list is safe to
 * hand-write — the loader refuses a document naming a provider it does not have,
 * and a rename is validated before it is stored, so a reference missed here
 * cannot be saved.
 *
 * Returns false when there is nothing to rename or the new id is taken, which the
 * caller answers rather than guessing at: renaming onto an existing provider would
 * silently merge two of them.
 */
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
