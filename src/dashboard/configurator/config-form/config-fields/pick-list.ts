import { scalarString } from '../document';
import type { Option } from '../model';
import type { BaseOptions, FieldBase } from './base';
import { at, baseField } from './base';

export const PICK_ADD = 'add:';
export const PICK_REMOVE = 'remove:';
export const PICK_DRAWN = '__pick:';

export type PickListSource = 'repositories';

export type PickListNote = { level: 'info' | 'warn'; text: string } | null;

export interface PickListEntry {
  value: string;
  note: PickListNote;
  offered: boolean;
}

export interface PickListOption extends Option {
  note: PickListNote;
}

export interface PickListField extends FieldBase {
  kind: 'pick-list';
  values: string[];
  entries: PickListEntry[];
  options: PickListOption[];
  source: PickListSource;
  addLabel: string;
  searchLabel: string;
  empty: string;
}

export interface PickListOptions extends BaseOptions {
  source: PickListSource;
  addLabel: string;
  searchLabel: string;
  empty: string;
}

export function pickListField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: PickListOptions,
): PickListField {
  const stored = at(root, path);
  const values = Array.isArray(stored) ? stored.map((value) => scalarString(value)) : [];
  return {
    ...baseField(path, schemaPath, label, options),
    kind: 'pick-list',
    values,
    entries: values.map((value) => ({ value, note: null, offered: false })),
    options: [],
    source: options.source,
    addLabel: options.addLabel,
    searchLabel: options.searchLabel,
    empty: options.empty,
  };
}
