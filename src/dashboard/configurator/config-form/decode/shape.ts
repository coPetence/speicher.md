import { Document } from 'yaml';

import {
  Collection,
  collectionsIn,
  sourceKindAt,
  submittedKeys,
  submittedKinds,
  submittedLength,
} from '../collections';
import { appendSeqItem, setNodeAt } from '../document';
import { sectionOf } from '../sections';
import { FormBody, submitted } from './body';

/**
 * Bring the document's repeatable parts into line with the shape the form had.
 *
 * A collection with no submitted shape is left alone rather than emptied: a
 * partial request — anything that is not this form — must not delete every
 * provider on the instance because it failed to mention them.
 */
export function reconcileStructure(doc: Document, body: FormBody, sectionId: string): boolean {
  let changed = false;

  // Twice, because a collection can only be seen once its parent exists: the
  // source list of a group added in this same request is not in the document
  // until the group itself has been created.
  for (let pass = 0; pass < 2; pass++) {
    const section = sectionOf(doc, sectionId);
    if (!section) return changed;
    for (const collection of collectionsIn(doc, section)) {
      if (collection.kind === 'map') {
        if (reconcileMap(doc, body, collection)) changed = true;
      } else if (reconcileList(doc, body, collection)) {
        changed = true;
      }
    }
  }

  return changed;
}

function reconcileMap(doc: Document, body: FormBody, collection: Collection): boolean {
  const submitted = submittedKeys(body, collection.path);
  if (submitted === null) return false;

  const path = collection.path.split('.');
  let changed = false;

  for (const key of collection.keys) {
    if (submitted.includes(key)) continue;
    doc.deleteIn([...path, key]);
    changed = true;
  }

  for (const key of submitted) {
    if (collection.keys.includes(key)) continue;
    setNodeAt(doc, [...path, key], seedFor(collection.path, key, body));
    changed = true;
  }

  return changed;
}

/**
 * The smallest thing that is still a member of this collection.
 *
 * Enough for the field model to render the right controls for it, and no more —
 * everything else arrives as a value in the same request. The variant matters:
 * seeding a provider with nothing would have the model render it as `oidc` and
 * drop every field belonging to the kind the operator actually chose. The value
 * read here is one the form itself offers, so this stays inside the gate.
 */
function seedFor(collectionPath: string, key: string, body: FormBody): unknown {
  if (collectionPath === 'groups') return [];

  const type = submitted(body, `${collectionPath}.${key}.type`)?.trim();
  return type ? { type } : {};
}

function reconcileList(doc: Document, body: FormBody, collection: Collection): boolean {
  /*
    Which form the shape takes is the **collection's** to say, never the value's:
    a kinded collection reads kinds, and a body carrying a count where kinds were
    expected reconciles to no members rather than to some of an invented kind. See
    `Collection.kinds`.
  */
  const kinds = collection.kinds ? submittedKinds(body, collection.path) : null;
  const submitted = kinds ? kinds.length : submittedLength(body, collection.path);
  if (submitted === null) return false;

  const path = collection.path.split('.');
  let changed = false;

  if (submitted !== collection.length) {
    // Truncate from the end and let the values fill the surviving slots. Removing
    // the middle of three renumbers the rest, so which entries survived is carried
    // by the values submitted under the new indices, not by the indices themselves.
    for (let index = collection.length - 1; index >= submitted; index--) {
      doc.deleteIn([...path, index]);
    }
    for (let index = collection.length; index < submitted; index++) {
      /*
        Seeded by the **kind at that position**, not by a single seed for the
        collection: a member rebuilt as the wrong shape has a field model that never
        heard of the paths the browser just submitted, so the values would be
        dropped behind a 200. See `Collection.seedOf`.
      */
      const seed = kinds ? collection.seedOf?.[kinds[index]] : undefined;
      appendSeqItem(doc, path, seed ?? collection.seed ?? {});
    }
    changed = true;
  }

  /*
    And then make every surviving position the **shape the page says it is**.

    Truncating from the end is only half of "the values say which entries survived",
    and the other half is invisible until the members stop being alike. A group whose
    sources are a mapping and then a person, with the mapping removed: the list is
    truncated to one, the surviving position still holds the mapping, and the
    person's submitted values are read against a model built for a mapping — so they
    are dropped, and the entry the operator deleted is the one that lives. The
    document ends up with the wrong survivor and nothing anywhere reports it.

    Replacing the item with its kind's seed is what lets the values land: the seed is
    the smallest thing of that shape, and everything else about the position is in
    the submission, including the provider, which every stored row carries.
  */
  if (kinds) {
    for (let index = 0; index < kinds.length; index++) {
      if (sourceKindAt(doc, [...path, index]) === kinds[index]) continue;
      setNodeAt(doc, [...path, index], collection.seedOf?.[kinds[index]] ?? {});
      changed = true;
    }
  }

  return changed;
}
