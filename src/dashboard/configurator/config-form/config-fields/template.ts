/**
 * The reader's page template
 */

import { scalarString } from '../document';
import type { Option } from '../model';
import type { BaseOptions, FieldBase } from './base';
import { at, baseField } from './base';

export interface TemplateField extends FieldBase {
  kind: 'template';
  value: string;
  fallback?: string;
  options: Option[];
}

export interface TemplateOptions extends BaseOptions {
  fallback?: string;
  options: Option[];
}

export function templateField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: TemplateOptions,
): TemplateField {
  const base = baseField(path, schemaPath, label, options);
  return {
    ...base,
    kind: 'template',
    value: base.inapplicable ? '' : scalarString(at(root, path)),
    fallback: options.fallback,
    options: options.options,
  };
}
