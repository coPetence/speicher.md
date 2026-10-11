/**
 * What a stored image is, written beside the picker that would replace it
 *
 * The document says `sha256:<hash>` and nothing else, so the type and the size
 * are a question for the store. Asked here rather than in the field model for
 * the reason every stamp on this surface exists: the model is built
 * synchronously, many times per request, and this is one query.
 */

import { BRAND_IMAGES, describeBytes } from '../../../config/brand';
import { brandImageFactsByHash } from '../../../config/brand-store';
import { STORED_IMAGE } from '../config-form/config-fields/file';
import { allFields } from '../config-form/model';
import { ConfigSectionPayload } from './payloads';

/**
 * Fills in the words for every stored image this page shows.
 *
 * A hash the store does not have is said plainly rather than left reading
 * "Stored image", which would describe something that is not there — the one
 * state an operator needs to see, because the repair is to upload it again.
 */
export async function stampBrandImages(
  tenantId: string,
  payload: ConfigSectionPayload,
): Promise<void> {
  if (!payload.section) return;

  const fields = allFields([payload.section]).filter(
    (field) => field.kind === 'file' && field.storedHash !== '' && field.stored === STORED_IMAGE,
  );
  if (fields.length === 0) return;

  const facts = await brandImageFactsByHash(
    tenantId,
    fields.map((field) => (field.kind === 'file' ? field.storedHash : '')),
  );

  for (const field of fields) {
    if (field.kind !== 'file') continue;
    const fact = facts.get(field.storedHash);
    if (!fact) {
      field.stored = 'Missing — this instance no longer has the image stored';
      field.thumbHref = '';
      continue;
    }
    // Named through the spec for this key, so the word beside a stored image is
    // the same word an inline one gets — see `storedImage`
    const spec = BRAND_IMAGES.find((each) => each.key === field.path);
    const type = (spec?.types[fact.media_type] ?? '').toUpperCase();
    field.stored = `${type}, ${describeBytes(fact.byte_size)}`;
  }
}
