/**
 * A text area stored as a list, one entry per line
 */

import { linesOf } from '../document';
import type { BaseOptions, FieldBase } from './base';
import { at, baseField } from './base';

export interface LinesField extends FieldBase {
  kind: 'lines';
  value: string;
  fallback?: string[];
  placeholder: string;
  // Height of the text area in lines
  rows: number;
  // Takes one grid column instead of a full row
  inColumn: boolean;
}

export interface LinesOptions extends BaseOptions {
  fallback?: string[];
  placeholder?: string;
  rows?: number;
  inColumn?: boolean;
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
    value: base.inapplicable ? '' : linesOf(at(root, path) ?? options.fallback),
    fallback: options.fallback,
    placeholder: options.placeholder ?? '',
    rows: options.rows ?? 4,
    inColumn: options.inColumn ?? false,
  };
}
