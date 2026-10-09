/**
 * The tenant of a Microsoft Entra ID provider
 */

import { scalarString } from '../document';
import { at } from './base';
import type { TextBox, TextBoxOptions } from './text';
import { textBox } from './text';

export interface EntraTenantField extends TextBox {
  kind: 'entra-tenant';
}

// Matches an Entra ID issuer URL and captures the tenant
const ENTRA_ISSUER = /^https:\/\/login\.microsoftonline\.com\/([^/\s]+)\/v2\.0$/;

export function entraTenantOf(issuer: string): string | null {
  return ENTRA_ISSUER.exec(issuer.trim())?.[1] ?? null;
}

export function entraIssuerFor(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant.trim()}/v2.0`;
}

export function entraTenantField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: TextBoxOptions = {},
): EntraTenantField {
  const box = textBox(root, path, schemaPath, label, options);
  return {
    ...box,
    kind: 'entra-tenant',
    value: box.inapplicable ? '' : (entraTenantOf(scalarString(at(root, path))) ?? ''),
  };
}
