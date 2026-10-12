/**
 * An image file, e.g. the brand logo, stored beside the configuration and
 * referred to by the content hash
 */

import type { BaseOptions, FieldBase } from './base';
import { baseField } from './base';

// Text next to the picker
export const STORED_IMAGE = 'Stored image';

export interface FileField extends FieldBase {
  kind: 'file';
  // What is stored, in words, e.g. "SVG, 2 KB"; empty while nothing is stored
  stored: string;
  // Hash of the stored image; empty when nothing is stored
  storedHash: string;
  thumbHref: string;
  // Media types the picker offers, e.g. `image/png,image/svg+xml`
  accept: string;
}

export interface FileOptions extends BaseOptions {
  stored?: string;
  storedHash?: string;
  accept?: string;
}

export function fileField(
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: FileOptions = {},
): FileField {
  const storedHash = options.storedHash ?? '';
  return {
    ...baseField(path, schemaPath, label, options),
    kind: 'file',
    stored: options.stored ?? '',
    storedHash,
    thumbHref: storedHash === '' ? '' : `/-/config/brand/${storedHash}`,
    accept: options.accept ?? '',
  };
}
