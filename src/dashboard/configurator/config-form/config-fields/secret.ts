/**
 * Secret field: masks stored values and supports `${ENV_VAR}` references
 */

import { SECRET_MASK } from '../../../../global-ui/secret-mask';
import { scalarString } from '../document';
import type { BaseOptions, FieldBase } from './base';
import { at, baseField } from './base';

export const SECRET_HELP =
  'Enter a secret or an environment variable reference like `${MY_SECRET}`. ' +
  'If self-hosting, set the variable where speicher.md runs (e.g. in Docker Compose) ' +
  'and restart speicher.md. Variable names must not start with `SPEICHER_`.';

// Matches `${ENV_VAR}` references
const PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export function isEnvPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && PLACEHOLDER.test(value);
}

export interface SecretUpload {
  // Accepted file types, e.g. `.pem,application/x-pem-file`
  accept: string;
  // Required content: GitHub App RSA key in PEM or passphrase-free SSH private key
  content: 'rsa-private-key' | 'ssh-private-key';
  // File picker button text
  label: string;
  // Drop zone text shown during a drag
  dropLabel: string;
}

export interface SecretField extends FieldBase {
  kind: 'secret';
  value: string;
  placeholder: string;
  secretHidden: boolean;
  upload?: SecretUpload;
  unsaved?: string;
  // Path to the same-page field to copy from
  sourceToCopyFrom?: string;
  // Copy a hidden stored secret on save instead of in the browser
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
    value: base.inapplicable ? '' : secretHidden ? SECRET_MASK : scalarString(stored),
    placeholder: options.placeholder ?? '',
    secretHidden,
    upload: options.upload,
    sourceToCopyFrom: options.sourceToCopyFrom,
    sourceToCopyFromOnSave: options.sourceToCopyFromOnSave,
  };
}
