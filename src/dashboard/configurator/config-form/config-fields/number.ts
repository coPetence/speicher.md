/**
 * A number box
 */

import type { TextBox, TextBoxOptions } from './text';
import { textBox } from './text';

export interface NumberField extends TextBox<number> {
  kind: 'number';
}

export function numberField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: TextBoxOptions<number> = {},
): NumberField {
  return { ...textBox(root, path, schemaPath, label, options), kind: 'number' };
}
