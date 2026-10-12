/**
 * This resolves brand images when exporting the instance config
 */

import { BRAND_IMAGES, parseBrandRef } from '../../../config/brand';
import { brandImagesByHash } from '../../../config/brand-store';
import { loadDocument, serialise } from './document';

export async function inlineBrandImages(tenantId: string, yaml: string): Promise<string> {
  let doc;
  try {
    doc = loadDocument(yaml);
  } catch {
    // Unparseable: there are no keys to find, and `exportConfig` says so itself.
    return yaml;
  }

  const wanted: { field: string; hash: string }[] = [];
  for (const spec of BRAND_IMAGES) {
    const stored = doc.getIn(['brand', spec.field]);
    if (typeof stored !== 'string') continue;
    const hash = parseBrandRef(stored);
    if (hash !== null) wanted.push({ field: spec.field, hash });
  }
  if (wanted.length === 0) return yaml;

  const rows = await brandImagesByHash(
    tenantId,
    wanted.map((each) => each.hash),
  );

  let inlined = false;
  for (const { field, hash } of wanted) {
    const row = rows.get(hash);
    if (!row) continue;
    doc.setIn(['brand', field], `data:${row.media_type};base64,${row.bytes.toString('base64')}`);
    inlined = true;
  }

  return inlined ? serialise(doc) : yaml;
}
