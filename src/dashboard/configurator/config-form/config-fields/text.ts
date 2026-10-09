/**
 * A single-line text box
 */

import { scalarString } from '../document';
import type { BaseOptions, FieldBase } from './base';
import { at, baseField } from './base';

export interface TextBox<V extends string | number = string> extends FieldBase {
  value: string;
  fallback?: V;
  placeholder: string;
  // Regular expression the browser checks the value against before the form is sent
  pattern: string;
  // The pattern in words, shown when the browser refuses a value
  patternHint: string;
}

export interface TextBoxOptions<V extends string | number = string> extends BaseOptions {
  fallback?: V;
  placeholder?: string;
  pattern?: string;
  patternHint?: string;
}

export function textBox<V extends string | number = string>(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: TextBoxOptions<V>,
): TextBox<V> {
  const base = baseField(path, schemaPath, label, options);
  return {
    ...base,
    value: base.inapplicable ? '' : scalarString(at(root, path) ?? options.fallback),
    fallback: options.fallback,
    placeholder: options.placeholder ?? '',
    pattern: options.pattern ?? '',
    patternHint: options.patternHint ?? '',
  };
}

export interface TextField extends TextBox {
  kind: 'text';
  // Path of a field on the same page whose value a button copies into this one
  sourceToCopyFrom?: string;
  // True when that field holds a stored secret the page does not show, so the copy
  // happens on save instead of in the browser
  sourceToCopyFromOnSave?: boolean;
}

export interface TextOptions extends TextBoxOptions {
  sourceToCopyFrom?: string;
  sourceToCopyFromOnSave?: boolean;
}

export function textField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: TextOptions = {},
): TextField {
  return {
    ...textBox(root, path, schemaPath, label, options),
    kind: 'text',
    sourceToCopyFrom: options.sourceToCopyFrom,
    sourceToCopyFromOnSave: options.sourceToCopyFromOnSave,
  };
}
