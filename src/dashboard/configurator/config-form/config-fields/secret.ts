/**
 * A secret: a password box that never shows a stored literal
 *
 * A secret is either typed in, which stores it in the configuration, or written as
 * a reference to an environment variable such as `${MY_SECRET}`
 */

import { scalarString } from '../document';
import type { BaseOptions, FieldBase } from './base';
import { at, baseField } from './base';

export const SECRET_HELP =
  'The secret can be entered directly, which stores it in the database, or as a ' +
  'reference to an environment variable such as `${MY_SECRET}.`' +
  'On a self-hosted instance, set the variable where Speicher runs, for example ' +
  'under `environment:` in `docker-compose.yml`, and restart Speicher. The name must ' +
  'not start with `SPEICHER_`. Learn more about ' +
  '[secrets](https://docs.speicher.md/operate/configuration).';

// Matches a reference to an environment variable, e.g. `${MY_SECRET}`
const PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export function isEnvPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && PLACEHOLDER.test(value);
}

export interface SecretUpload {
  // Media types and extensions the file picker offers, e.g. `.pem,application/x-pem-file`
  accept: string;
  // What the file must contain: a GitHub App's RSA key in PEM, or a private SSH key
  // without a passphrase
  content: 'rsa-private-key' | 'ssh-private-key';
  // Text of the button that opens the file picker
  label: string;
  // Text shown in the rectangle while a file is dragged over the page
  dropLabel: string;
}

export interface SecretField extends FieldBase {
  kind: 'secret';
  value: string;
  placeholder: string;
  secretHidden: boolean;
  upload?: SecretUpload;
  unsaved?: string;
  // Path of a field on the same page whose value a button copies into this one
  sourceToCopyFrom?: string;
  // True when that field holds a stored secret the page does not show, so the copy
  // happens on save instead of in the browser
  sourceToCopyFromOnSave?: boolean;
}

export interface SecretOptions extends BaseOptions {
  placeholder?: string;
  upload?: SecretUpload;
  sourceToCopyFrom?: string;
  sourceToCopyFromOnSave?: boolean;
}

export function secretField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: SecretOptions = {},
): SecretField {
  const stored = at(root, path);
  const base = baseField(path, schemaPath, label, options);
  const secretHidden = stored !== undefined && !isEnvPlaceholder(stored);
  return {
    ...base,
    kind: 'secret',
    value: base.inapplicable || secretHidden ? '' : scalarString(stored),
    placeholder: options.placeholder ?? '',
    secretHidden,
    upload: options.upload,
    sourceToCopyFrom: options.sourceToCopyFrom,
    sourceToCopyFromOnSave: options.sourceToCopyFromOnSave,
  };
}
