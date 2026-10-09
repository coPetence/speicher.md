/**
 * A switch over one name in a list, e.g. whether a group is one of the admin groups
 *
 * Turning it on adds the name to the list and turning it off removes it
 */

import { scalarString } from '../document';
import type { BaseOptions, FieldBase } from './base';
import { at, baseField } from './base';

export interface MembershipField extends FieldBase {
  kind: 'membership';
  // True while the list holds `trueValue`
  checked: boolean;
  values: string[];
  // The value this switch adds to and removes from the list
  trueValue: string;
}

export interface MembershipOptions extends BaseOptions {
  trueValue: string;
}

export function membershipField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: MembershipOptions,
): MembershipField {
  const stored = at(root, path);
  const values = Array.isArray(stored) ? stored.map((value) => scalarString(value)) : [];
  return {
    ...baseField(path, schemaPath, label, options),
    kind: 'membership',
    checked: values.includes(options.trueValue),
    values,
    trueValue: options.trueValue,
  };
}
