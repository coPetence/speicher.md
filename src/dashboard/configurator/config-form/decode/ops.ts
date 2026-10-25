import { Document } from 'yaml';

import { referencesOf, referrersOf } from '../../../../config/groups';
import type { GroupItem } from '../../../../config/types';
import { GROUP_ADD, ROW_KINDS, RowKind } from '../collections';
import { appendSeqItem, dottedPath, parseLines, removeAt, setNodeAt, writeAt } from '../document';
import { FormSection, allFields, allOps } from '../model';
import { seedForge } from '../members';
import { FormBody, submitted, submittedList } from './body';

/** What a structural operation did: whether it was one, and whether it wrote. */
export interface OpResult {
  structural: boolean;
  changed: boolean;
}

const NOTHING: OpResult = { structural: false, changed: false };

/** The structural operation a submission carries, if the page offered it. */
export function applyOp(
  doc: Document,
  body: FormBody,
  op: string,
  rebuilt: FormSection | undefined,
): OpResult {
  // Only operations the form just offered. Anything else is ignored rather than
  // guessed at — the same rule as the field paths, for the same reason. Rebuilt
  // from the edited document, because a value applied above can have added the
  // card whose Remove button is being pressed.
  const offered = new Set(rebuilt ? allOps([rebuilt]) : []);
  if (!offered.has(op) && !offered.has(op.replace(/\.\d+$/, ''))) {
    return NOTHING;
  }

  const verb = op.slice(0, op.indexOf(':'));

  /*
    The bulk removal, which is one operation over several positions.

    Which positions is **not** read from the body as positions: each checkbox
    carries its own row's `remove:` operation, and only the ones this section
    actually offered survive the filter — the same gate a single removal passes,
    applied once per box. A body naming `remove:groups.other.0` from this page
    reaches nothing.

    Highest position first, because a group's sources are a sequence: deleting from
    the front renumbers everything behind it, so the second deletion would take the
    wrong row and the last would be out of range. It is the property
    `reconcileList` truncates from the end for, and the one the provider-wide
    removal already sorts for.
  */
  if (verb === 'remove-selected') {
    const selected = submittedList(body, 'select').filter((each) => offered.has(each));
    for (const each of selected.sort(byDescendingPosition)) applyStructural(doc, body, each);
    return { structural: true, changed: selected.length > 0 };
  }

  /*
    Taking every answer on this page back out of the document.

    A third verb, and it needs one: `remove:` names a node and deletes it, which is
    the wrong shape here twice over. The page's answers do not live under one key —
    `theme.font` sits beside `theme.palette`, and `theme.template` is set on the
    page above and must survive — and what an operator means by "reset" is that the
    *template's* own answer stands again, which in this document is spelled by the
    key being absent rather than by any value.

    So the target is the **section id**, not a path, and what is cleared is every
    path the section's own field model offers. That keeps the rule the rest of this
    file is built on — a request can only write where the form just offered — and it
    keeps the answer in one place: a control added to the page is reset by it with
    nothing here to remember. `writeAt` with no value prunes the empty parents, so
    what comes back out is the document the operator would have written by hand.

    A round trip like the other structural operations: the page comes back cleared
    with the save bar open, so walking away is what undoes it.
  */
  if (verb === 'reset') {
    const cleared = resetSection(doc, rebuilt);
    return { structural: true, changed: cleared };
  }

  if (verb !== 'add' && verb !== 'remove') return NOTHING;

  applyStructural(doc, body, op);
  return { structural: true, changed: true };
}

/**
 * Clear every value the section offers, so the defaults behind them stand again.
 *
 * Reads the same field model the page was rendered from, which is what makes this
 * one function rather than one per page: the paths it clears are by construction
 * the paths that page can write.
 */
function resetSection(doc: Document, section: FormSection | undefined): boolean {
  let changed = false;
  for (const field of section ? allFields([section]) : []) {
    if (writeAt(doc, dottedPath(field.path), undefined)) changed = true;
  }
  return changed;
}

/**
 * Operations on positions of one sequence, deepest first.
 *
 * The position is the last dotted segment, and an operation that has none sorts
 * before every one that does — nothing in this codebase mixes the two in a single
 * selection, and an ordering that quietly did the wrong thing if something ever did
 * is worse than one that puts it first and leaves the indices behind it intact.
 */
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
      // A new provider is written with the smallest thing that is still a provider
      // of that kind: enough for the form to render its fields, and not so much
      // that it looks configured when it is not.
      setNodeAt(doc, [...path, name], type === 'oidc' || type === '' ? { type: 'oidc' } : { type });
      return;
    }
    case 'groups': {
      if (name === '') return;
      // No source at all, which is `seedMember`'s answer for the same collection —
      // two spellings of one seed is how they come to disagree. A group with no
      // source makes nobody a member and loads, so nothing has to be typed before
      // the name can be saved.
      setNodeAt(doc, [...path, name], []);
      return;
    }
    case 'forges': {
      if (name === '') return;
      // The same seed the member's own page is drafted from, from the same
      // function: two answers to "what is the smallest content source" would
      // differ the day one of them was corrected, and the difference would be a
      // card that appears on the first save.
      setNodeAt(doc, [...path, name], seedForge(type));
      return;
    }
    case 'admins.users': {
      appendSeqItem(doc, path, {});
      return;
    }
    default: {
      // `forges.<id>.repos` — the one collection whose add button carries no name,
      // because the entry is identified by its contents.
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
