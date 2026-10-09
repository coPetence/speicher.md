/**
 * A text area stored as one string with line breaks, e.g. an SSH host key list
 */

import { scalarString } from '../document';
import type { BaseOptions, FieldBase } from './base';
import { at, baseField } from './base';

export interface MultilineField extends FieldBase {
  kind: 'multiline';
  value: string;
  // Height of the text area in lines
  rows: number;
}

export interface MultilineOptions extends BaseOptions {
  rows?: number;
}

export function multilineField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: MultilineOptions = {},
): MultilineField {
  const base = baseField(path, schemaPath, label, options);
  return {
    ...base,
    kind: 'multiline',
    value: base.inapplicable ? '' : scalarString(at(root, path)),
    rows: options.rows ?? 4,
  };
}
