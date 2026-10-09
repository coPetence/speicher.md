/**
 * A group of checkboxes, stored as the list of the values that are ticked
 */

import { scalarString } from '../document';
import type { Option } from '../model';
import type { BaseOptions, FieldBase } from './base';
import { at, baseField } from './base';

export interface CheckboxesField extends FieldBase {
  kind: 'checkboxes';
  values: string[];
  options: Option[];
}

export interface CheckboxesOptions extends BaseOptions {
  options: Option[];
}

export function checkboxesField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: CheckboxesOptions,
): CheckboxesField {
  const stored = at(root, path);
  return {
    ...baseField(path, schemaPath, label, options),
    kind: 'checkboxes',
    values: Array.isArray(stored) ? stored.map((value) => scalarString(value)) : [],
    options: options.options,
  };
}
