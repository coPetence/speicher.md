import { Document, isMap, isSeq } from 'yaml';

import type { SelectField } from '../config-fields';
import { writeAt } from '../document';
import { FormSection, allFields } from '../model';
import { MemberRef, memberPath } from '../members';
import { FormBody } from './body';

/**
 * Repairs the field model cannot make on its own.
 *
 * Each is a no-op on an untouched form, which is what keeps a save that changed
 * nothing byte-identical to the version before it.
 */

/**
 * Tidy up after the trailing rows: stamp the provider on what was typed, drop what
 * was not.
 *
 * A source's page draws one empty row at the end of each of its two tables, and
 * those rows write straight to the next positions of the group's sequence. Two
 * things follow that the field model cannot do on its own.
 *
 * **A typed trailing row has no provider.** It cannot carry one: a hidden control
 * holding the page's provider would submit a real value on every save, so a page
 * somebody opened and closed would append a source consisting of nothing but a
 * provider — and, worse, would report the document as changed and re-serialise it,
 * which is how an untouched form starts appending versions that differ by
 * whitespace. So the row carries nothing, and the provider is written here, to
 * whichever positions turned out to name somebody.
 *
 * **An untouched trailing row may still leave a hole.** The people table's row is
 * the position *after* the mappings table's, so filling in only a person writes
 * past the end and `yaml` pads the gap with a null. That null is dropped here,
 * along with any position that names nobody — which is exactly the "saving with an
 * empty row ignores it" rule, arrived at from the document's side rather than the
 * form's.
 *
 * Both halves are no-ops when nothing was typed, which is what keeps an untouched
 * save byte-identical: nothing was written, so there is no position to stamp and no
 * hole to close.
 */
export function settleGroupSources(doc: Document, name: string, provider: string): boolean {
  const list = doc.getIn(['groups', name], true);
  if (!isSeq(list)) return false;

  let changed = false;
  const kept: unknown[] = [];
  for (const item of list.items) {
    // A position that names nobody is a row nobody typed into, or the null `yaml`
    // padded a gap with. Either way it is not a source, and the schema would refuse
    // the document for it.
    if (!namesSomebody(item)) {
      changed = true;
      continue;
    }
    // Only a *new* source can be missing its provider — every stored one carries it
    // in a hidden control — so this cannot overwrite a source that names another.
    if (isMap(item) && !item.has('provider')) {
      // In front, where every source written by hand has it. `set` appends, which
      // would put the provider under the address it qualifies and make a new source
      // read differently from the ones above it for no reason a reader could see.
      item.items.unshift(doc.createPair('provider', provider));
      changed = true;
    }
    kept.push(item);
  }

  if (changed) list.items = kept as typeof list.items;
  return changed;
}

/**
 * A directory block whose kind was cleared is a directory block that goes.
 *
 * The provider's page renders every control the block has, whether or not one is
 * stored — see `directoryFields`, where the reason is that picking the kind and
 * filling it in have to be one submission. The controls therefore keep submitting
 * what they hold after the select has gone back to "not configured", and
 * `directory` without a `type` is a document the loader refuses: `type` is the one
 * key the schema requires there. So an operator turning the lookup off would get a
 * refusal naming a key they had just answered.
 *
 * Deleting the *block* rather than each of its keys is what makes that a single
 * decision. It cannot reach a directory the page did not draw: `memberPath` is
 * built from the section id, which the route has already resolved to a provider,
 * and a section with no directory in it has nothing at this path to delete.
 *
 * A no-op on every other save, including the ones that never had a block — so an
 * untouched form still reports `changed: false` and the stored text is passed
 * through byte for byte.
 */
export function settleDirectory(doc: Document, member: MemberRef): boolean {
  if (member.section !== 'identity') return false;

  const path = [...memberPath(member), 'directory'];
  if (!doc.hasIn(path)) return false;
  // Empty counts as absent: the select submits `''` for "not configured", and
  // `writeAt` will already have removed the key — this is the case where the boxes
  // beneath it kept the block alive.
  const type = doc.getIn([...path, 'type']);
  if (typeof type === 'string' && type !== '') return false;

  doc.deleteIn(path);
  return true;
}

/** Whether a source names anybody at all — the four keys that identify one. */
function namesSomebody(item: unknown): boolean {
  if (!isMap(item)) return false;
  return ['id', 'domain', 'subject', 'email'].some((key) => {
    const value = item.get(key);
    return value !== undefined && value !== null && String(value).trim() !== '';
  });
}

/**
 * The driver a half-filled asset block still needs.
 *
 * `assets.driver` has a schema default, so a page left showing `filesystem` writes
 * nothing — which is what a default means and is right for every other optional
 * key. It is wrong for this one: `driver` is *required* whenever the block exists,
 * and the block comes into existence the moment any other control on the page is
 * filled in. On an instance with no `assets:` at all — which is every fresh one —
 * setting a volume path was therefore refused for a key whose control was on
 * screen, set correctly, and deliberately not written. Nothing on the page could
 * fix it, because picking the driver it already showed writes nothing either.
 *
 * Only from a page that rendered the control, and only into a block that has
 * something else in it: writing it on any other terms is how an untouched Save
 * starts appending an `assets` block to a document that had none.
 *
 * The submitted value and not the default, so this settles the *page's* answer
 * rather than a second opinion about what the driver is. A driver that differs from
 * the default has already been written by the field walk, so this only ever fires
 * on the branch whose value equals it. The path comes off the field model like
 * every other write here: a body naming it from a page that renders no driver
 * reaches nothing.
 */
export function settleAssetDriver(doc: Document, body: FormBody, section: FormSection): boolean {
  const control = allFields([section]).find(
    (each): each is SelectField => each.kind === 'select' && each.path === 'assets.driver',
  );
  if (!control) return false;

  const submitted = body[control.path];
  const driver =
    typeof submitted === 'string' && submitted !== '' ? submitted : (control.fallback ?? '');
  if (driver === '') return false;

  const block = doc.getIn(['assets'], true);
  if (!isMap(block) || block.items.length === 0) return false;
  if (doc.hasIn(['assets', 'driver'])) return false;

  return writeAt(doc, control.path.split('.'), driver);
}
