import { Document } from 'yaml';

import { addTarget } from '../collections';
import { appendSeqItem, dottedPath, removeAt, setNodeAt, writeAt } from '../document';
import type { Obj } from '../config-fields';
import { FormSection, allFields, allOps } from '../model';
import { seedForge, sourcePositions } from '../members';
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

/**
 * A group and one provider it draws from — the target of every operation a
 * source's page offers.
 *
 * The literal segment is what keeps it from reading as a path into the document,
 * and it is load-bearing rather than decorative: a group's sources are a sequence,
 * so `groups.eng.2` names a *position*, and a provider's short id may be `2`. Two
 * operations spelled the same and meaning different things is the bug the rename
 * collision already was; a segment no document path can have is the cheapest way to
 * make that impossible.
 *
 * Two verbs, because the page adds two shapes: `provider` appends a mapping and
 * `person` appends an individual. Removal is spelled with `provider` alone — it
 * takes every source under that provider, whichever shape each one is.
 */
const GROUP_PROVIDER = /^groups\.([^.]+)\.(provider|person)\.(.+)$/;

function applyStructural(doc: Document, body: FormBody, op: string): void {
  const [verb, target] = [op.slice(0, op.indexOf(':')), op.slice(op.indexOf(':') + 1)];
  const path = dottedPath(target);
  const scoped = GROUP_PROVIDER.exec(target);

  if (verb === 'remove') {
    if (scoped) {
      /*
        Every source in the group that names this provider, **highest position
        first**. Deleting from the front renumbers everything behind it, so the
        second deletion would take the wrong source and the last would be out of
        range — which is the same property `reconcileList` truncates from the end
        for.
      */
      const root = doc.toJS({ maxAliasCount: 0 }) as Obj;
      const positions = sourcePositions(root, scoped[1], scoped[3]);
      for (const index of positions.reverse()) removeAt(doc, ['groups', scoped[1], index]);
      return;
    }
    removeAt(doc, path);
    return;
  }

  if (scoped) {
    /*
      One more source on the provider whose page this was pressed on, in the shape
      the button says. Both come from the op — which `allOps` checked against what
      the page offered — and not from a hidden control, which would be
      caller-supplied on the endpoint that writes `admins`.

      The seed is `addTarget`'s, so the round trip and the reconciliation that
      rebuilds it a request later agree about what was made. Two spellings of the
      same seed is how they would come to disagree.
    */
    appendSeqItem(doc, ['groups', scoped[1]], addTarget(op).seed ?? {});
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
      // `groups.<name>` and `forges.<id>.repos` — the two collections whose add
      // button carries no name, because the entry is identified by its contents.
      if (/^groups\.[^.]+$/.test(target)) {
        appendSeqItem(doc, path, {});
        return;
      }
      if (/^forges\.[^.]+\.repos$/.test(target)) {
        appendSeqItem(doc, path, {});
      }
    }
  }
}
