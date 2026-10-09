/**
 * An image file, e.g. the brand logo, stored in the configuration as a `data:` URI
 */

import type { BaseOptions, FieldBase } from './base';
import { baseField } from './base';

export interface FileField extends FieldBase {
  kind: 'file';
  // What is stored, in words, e.g. "SVG, 2 KB"; empty while nothing is stored
  stored: string;
  // Name the stored image is served under at `/-/brand/`, for the thumbnail
  storedFile: string;
  // Media types the file picker offers, e.g. `image/png,image/svg+xml`
  accept: string;
}

export interface FileOptions extends BaseOptions {
  stored?: string;
  storedFile?: string;
  accept?: string;
}

export function fileField(
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: FileOptions = {},
): FileField {
  return {
    ...baseField(path, schemaPath, label, options),
    kind: 'file',
    stored: options.stored ?? '',
    storedFile: options.storedFile ?? '',
    accept: options.accept ?? '',
  };
}
