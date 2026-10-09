/**
 * A dropdown with one value out of a fixed list of options
 */

import { scalarString } from '../document';
import type { Option } from '../model';
import type { BaseOptions, FieldBase } from './base';
import { at, baseField } from './base';

export interface SelectField extends FieldBase {
  kind: 'select';
  value: string;
  fallback?: string;
  options: Option[];
  // True when the choice decides which other fields the page has, e.g. the storage
  // driver: changing it sends the form, and the server answers with the new fields
  reshapes: boolean;
}

export interface SelectOptions extends BaseOptions {
  fallback?: string;
  options: Option[];
  reshapes?: boolean;
}

export function selectField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: SelectOptions,
): SelectField {
  const base = baseField(path, schemaPath, label, options);
  return {
    ...base,
    kind: 'select',
    value: base.inapplicable ? '' : scalarString(at(root, path)),
    fallback: options.fallback,
    options: options.options,
    reshapes: options.reshapes === true,
  };
}
