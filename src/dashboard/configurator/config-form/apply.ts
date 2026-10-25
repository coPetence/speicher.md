/**
 * Apply a form submission to the config document
 *
 * In sequence: reconcile structure from __shape: controls, apply fields that
 * reshape which other fields exist, re-derive the section model, apply all
 * remaining fields, settle member-specific concerns, apply the operation
 *
 * Returns whether the document structure changed and whether any field values
 * changed
 */

import { Document } from 'yaml';

import { allFields } from './model';
import { KindHint, memberOf } from './members';
import { sectionOf } from './sections';
import { FormBody } from './decode/body';
import { applyField } from './decode/fields';
import { applyOp } from './decode/ops';
import {
  settleAssetDriver,
  settleChoices,
  groupSourceSnapshot,
  settleDirectory,
  settleGroupSources,
  settleRepositoryIds,
} from './decode/settle';
import { reconcileStructure } from './decode/shape';

export type { FormBody } from './decode/body';

/**
 * Apply a form body to a YAML document for one section
 *
 * Fields marked reshapes are applied first so the section model is rebuilt
 * with the right field set before the main field pass
 *
 * Returns structural (members added or removed) and changed (field values)
 */
export function applyForm(
  doc: Document,
  body: FormBody,
  sectionId: string,
  hint?: KindHint,
): { structural: boolean; changed: boolean } {
  const member = memberOf(sectionId);
  const storedSources =
    member?.section === 'groups' ? groupSourceSnapshot(doc, member.id) : undefined;

  let changed = reconcileStructure(doc, body, sectionId);

  const before = sectionOf(doc, sectionId, hint);
  for (const field of before ? allFields([before]) : []) {
    if (field.kind === 'select' && field.reshapes && applyField(doc, body, field)) changed = true;
  }

  const section = sectionOf(doc, sectionId, hint);

  if (!section) return { structural: false, changed };

  for (const field of allFields([section])) {
    if (applyField(doc, body, field)) changed = true;
  }

  if (member && storedSources && settleGroupSources(doc, member.id, storedSources)) changed = true;

  if (settleAssetDriver(doc, body, section)) changed = true;

  if (settleRepositoryIds(doc, section)) changed = true;

  if (settleChoices(doc, body, section)) changed = true;

  if (member && settleDirectory(doc, member)) changed = true;

  const op = typeof body.op === 'string' ? body.op : '';
  if (op === '') return { structural: false, changed };

  const applied = applyOp(doc, body, op, sectionOf(doc, sectionId, hint));
  return { structural: applied.structural, changed: changed || applied.changed };
}
