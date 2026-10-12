/**
 * Used to show info about stored brand images next to the logo pickers
 */

import { BRAND_IMAGES, describeBytes } from '../../../config/brand';
import { brandImageFactsByHash } from '../../../config/brand-store';
import { STORED_IMAGE } from '../config-form/config-fields/file';
import { allFields } from '../config-form/model';
import { ConfigSectionPayload } from './payloads';

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
    
    const spec = BRAND_IMAGES.find((each) => each.key === field.path);
    const type = (spec?.types[fact.media_type] ?? '').toUpperCase();
    field.stored = `${type}, ${describeBytes(fact.byte_size)}`;
  }
}
