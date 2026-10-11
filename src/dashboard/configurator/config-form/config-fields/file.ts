/**
 * An image file, e.g. the brand logo, stored beside the configuration and
 * referred to from it by the hash of its own bytes
 */

import type { BaseOptions, FieldBase } from './base';
import { baseField } from './base';

/**
 * Said beside the picker when the words for an image are not in hand yet.
 *
 * A document referring to a stored image says only its hash, so the type and
 * size are a question for the store rather than for the document — asked, and
 * answered over this, by `stampBrandImages`. It is a complete sentence on its
 * own because the page renders without that step on the paths that have no
 * tenant to ask: the config view, and the export.
 */
export const STORED_IMAGE = 'Stored image';

export interface FileField extends FieldBase {
  kind: 'file';
  // What is stored, in words, e.g. "SVG, 2 KB"; empty while nothing is stored
  stored: string;
  // Hash of the stored image; empty when nothing is stored, or when what is
  // stored is not an image this instance could read
  storedHash: string;
  // Where the thumbnail is fetched from; empty when there is nothing to show
  thumbHref: string;
  // Media types the file picker offers, e.g. `image/png,image/svg+xml`
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
    /*
      One route for both forms a stored image takes.

      The thumbnail cannot come from `/-/brand/`, which serves what the *running*
      configuration resolved to: an image picked a moment ago and not yet saved
      is in no configuration at all, and that is exactly when somebody wants to
      see what they picked. `/-/config/brand/` answers for anything this instance
      holds, to an administrator, which is who is looking.
    */
    thumbHref: storedHash === '' ? '' : `/-/config/brand/${storedHash}`,
    accept: options.accept ?? '',
  };
}
