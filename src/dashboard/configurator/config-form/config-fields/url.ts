import type { TextBox, TextBoxOptions } from './text';
import { textBox } from './text';

export interface UrlField extends TextBox {
  kind: 'url';
}

export function urlField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: TextBoxOptions = {},
): UrlField {
  return { ...textBox(root, path, schemaPath, label, options), kind: 'url' };
}

/**
 * An address with `https://` in front
 *
 * If it already has a scheme its left untouched (e.g. `http://127.0.0.1:51000` survives)
 */
export function withHttpsScheme(value: string): string {
  if (value === '' || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `https://${value}`;
}
