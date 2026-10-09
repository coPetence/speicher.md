/**
 * A hex colour, typed into a text box beside a colour picker
 */

import type { TextBox, TextBoxOptions } from './text';
import { textBox } from './text';

export interface ColorField extends TextBox {
  kind: 'color';
}

export function colorField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: TextBoxOptions = {},
): ColorField {
  return { ...textBox(root, path, schemaPath, label, options), kind: 'color' };
}
