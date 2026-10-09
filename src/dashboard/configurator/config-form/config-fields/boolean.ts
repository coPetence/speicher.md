/**
 * An on/off switch
 */

import type { BaseOptions, FieldBase } from './base';
import { at, baseField } from './base';

export interface BooleanField extends FieldBase {
  kind: 'boolean';
  checked: boolean;
  fallback?: boolean;
  // When set, the switch stores this value instead of `true` and is on while the key
  // holds it, e.g. the provider id `auth.default_provider` names. Turning it off
  // clears the key only while it still holds this value
  trueValue?: string;
}

export interface BooleanOptions extends BaseOptions {
  fallback?: boolean;
  trueValue?: string;
}

export function booleanField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: BooleanOptions = {},
): BooleanField {
  const stored = at(root, path);
  return {
    ...baseField(path, schemaPath, label, options),
    kind: 'boolean',
    checked:
      options.trueValue !== undefined
        ? stored === options.trueValue
        : stored === undefined
          ? (options.fallback ?? false)
          : stored === true,
    fallback: options.fallback,
    trueValue: options.trueValue,
  };
}
