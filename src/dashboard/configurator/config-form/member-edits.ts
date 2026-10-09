import { Document, isMap, isSeq } from 'yaml';

import { appendSeqItem, renameMapKey, setNodeAt, writeAt } from './document';
import type { Obj } from './config-fields';
import { MemberRef, memberPath, seedMember, sourcePositions } from './members';

/**
 * Edits to a document that are about a member as a whole — whether it exists,
 * bringing it into existence, and giving it a different key — rather than about
 * any one of its values, which is what `decode/` does.
 */

/**
 * Whether the document already has the member a page is about.
 *
 * Two questions with one name, because the route that creates a member is one
 * route and a branch inside it would be the second place that knows what a member
 * *is*. A member of a map or of a sequence is a node, so the answer is whether
 * there is one; an entry is a **view** over its member's sequence — every source
 * of this group naming this provider — so the answer is whether that view has
 * anything in it.
 */
export function memberExists(doc: Document, ref: MemberRef): boolean {
  if (ref.entry === null) return doc.getIn(memberPath(ref)) !== undefined;
  const root = doc.toJS({ maxAliasCount: 0 }) as Obj;
  return sourcePositions(root, ref.id, ref.entry).length > 0;
}

/**
 * Bring the member a page is about into existence, in the document it belongs to.
 *
 * One entry point for the same reason `memberExists` is one, and the entry case is
 * why it writes rather than returning a value to be written: an entry is not a
 * node at a path, it is one more item in its member's list, and the member itself
 * may not exist yet. **Creating a group and its first source is one save** — the
 * modal on the groups index asks for the name and the provider and lands here — so
 * the seed has to be able to make both. A group seeded on its own page would be an
 * empty list, which the schema refuses, on a page with no control that could fill
 * it in.
 */
export function seedMemberInto(doc: Document, ref: MemberRef, kind: string): void {
  if (ref.entry === null) {
    // `setNodeAt` rather than `setIn` with a plain object — see the note on that
    // function: a plain array survives serialising and then fails on the first
    // write *into* it.
    setNodeAt(doc, memberPath(ref), seedMember(ref, kind));
    return;
  }
  appendSeqItem(doc, memberPath(ref), { provider: ref.entry });
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
 * Rename a group, and the one other place in this document that names it.
 *
 * `admins.groups` is that place, and it is the one that matters: a dangling entry
 * there is not a group that grants nothing, it is an administrator block that
 * resolves to fewer people — and the loader refuses a document whose `admins.groups`
 * names a group the map does not define, so a missed reference cannot be stored.
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

  return true;
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

  const groups = doc.getIn(['groups'], true);
  if (isMap(groups)) {
    for (const item of groups.items) {
      const name = keyOf(item.key);
      if (name === null) continue;
      const sources = doc.getIn(['groups', name], true);
      if (!isSeq(sources)) continue;
      sources.items.forEach((_, index) => {
        if (doc.getIn(['groups', name, index, 'provider']) === from) {
          writeAt(doc, ['groups', name, index, 'provider'], to);
        }
      });
    }
  }

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
