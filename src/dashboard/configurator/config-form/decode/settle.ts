import { Document, isMap, isSeq } from 'yaml';

import type { SelectField } from '../config-fields';
import { belongsToChoiceOption } from '../config-fields/choice';
import { dottedPath, writeAt } from '../document';
import { MemberRef, memberPath } from '../members';
import { FormSection, allFields, cardItems, fieldsOf } from '../model';
import { defaultRepositoryId } from '../sections/content-sources/git-repository-card';
import { FormBody } from './body';

export function settleGroupSources(doc: Document, name: string): boolean {
  const list = doc.getIn(['groups', name], true);
  if (!isSeq(list)) return false;

  let changed = false;
  const kept = list.items.filter((item) => namesSomebody(item));
  if (kept.length !== list.items.length) {
    list.items = kept as typeof list.items;
    changed = true;
  }
  for (const item of kept) if (providerFirst(item)) changed = true;
  return changed;
}

function providerFirst(item: unknown): boolean {
  if (!isMap(item)) return false;
  const at = item.items.findIndex((pair) => keyOf(pair.key) === 'provider');
  if (at <= 0) return false;
  const [pair] = item.items.splice(at, 1);
  item.items.unshift(pair);
  return true;
}

/** A map item's key, in either of the two shapes a key comes in. */
function keyOf(key: unknown): string | null {
  if (typeof key === 'string') return key;
  const value = (key as { value?: unknown } | null)?.value;
  return typeof value === 'string' ? value : null;
}

export function settleDirectory(doc: Document, member: MemberRef): boolean {
  if (member.section !== 'identity') return false;

  const path = [...memberPath(member), 'directory'];
  if (!doc.hasIn(path)) return false;

  if (doc.getIn([...memberPath(member), 'type']) === 'github') {
    const hasApp = ['app_id', 'private_key'].some((key) => {
      const value = doc.getIn([...path, key]);
      return typeof value === 'string' && value.trim() !== '';
    });
    if (!hasApp) {
      doc.deleteIn(path);
      return true;
    }
    if (doc.getIn([...path, 'type']) === 'github') return false;
    doc.setIn([...path, 'type'], 'github');
    return true;
  }
  // Empty counts as absent: the select submits `''` for "not configured", and
  // `writeAt` will already have removed the key — this is the case where the boxes
  // beneath it kept the block alive.
  const type = doc.getIn([...path, 'type']);
  if (typeof type === 'string' && type !== '') return false;

  doc.deleteIn(path);
  return true;
}

/** Whether an item names anybody at all — the four keys that identify a source, or the group a reference names. */
function namesSomebody(item: unknown): boolean {
  if (!isMap(item)) return false;
  return ['id', 'domain', 'subject', 'email', 'group'].some((key) => {
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

/**
 * settleRepositoryIds fills in the id of each git repository on the page that has none. The id is the name of the repository in its remote URL.
 * @param doc the configuration document
 * @param section the page the form was submitted from
 */
export function settleRepositoryIds(doc: Document, section: FormSection): boolean {
  let changed = false;
  for (const field of allFields([section])) {
    if (field.schemaPath !== 'forges.<key>.repos.<index>.id') continue;
    const path = dottedPath(field.path);
    const id = doc.getIn(path);
    if (typeof id === 'string' && id.trim() !== '') continue;
    const url = doc.getIn([...path.slice(0, -1), 'url']);
    const name = typeof url === 'string' ? defaultRepositoryId(url) : '';
    if (name !== '' && writeAt(doc, path, name)) changed = true;
  }
  return changed;
}

/**
 * Removes the values of the options that were not chosen in each choice on the
 * page, e.g. the access token of a git remote switched to SSH.
 */
export function settleChoices(doc: Document, body: FormBody, section: FormSection): boolean {
  let changed = false;
  for (const item of cardItems([section])) {
    if (item.kind !== 'choice') continue;

    const submitted = body[item.name];
    const value = item.follows ? doc.getIn(dottedPath(item.follows.path)) : undefined;
    const chosen =
      typeof submitted === 'string'
        ? item.options.find((option) => option.value === submitted)
        : item.options.find(
            (option) => typeof value === 'string' && belongsToChoiceOption(option, value.trim()),
          );
    if (!chosen) continue;

    for (const option of item.options) {
      if (option === chosen) continue;
      for (const field of fieldsOf(option.items)) {
        if (writeAt(doc, dottedPath(field.path), undefined)) changed = true;
      }
    }
  }
  return changed;
}
