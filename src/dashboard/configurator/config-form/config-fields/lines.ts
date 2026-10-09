/**
 * A text area stored as a list, one entry per line
 */

import { linesOf } from '../document';
import type { BaseOptions, FieldBase } from './base';
import { at, baseField } from './base';

export interface LinesField extends FieldBase {
  kind: 'lines';
  value: string;
  // Height of the text area in lines
  rows: number;
}

export interface LinesOptions extends BaseOptions {
  rows?: number;
}

export function linesField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: LinesOptions = {},
): LinesField {
  const base = baseField(path, schemaPath, label, options);
  return {
    ...base,
    kind: 'lines',
    value: base.inapplicable ? '' : linesOf(at(root, path)),
    rows: options.rows ?? 4,
  };
}
