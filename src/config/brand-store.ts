/**
 * Handles the `brand_images` db table
 *
 * writing to it is idempotent using the content hash
 */

import { QueryTypes } from 'sequelize';

import { getSequelize } from '../db/sequelize';
import type { BrandImage } from './brand';

export interface StoredBrandImage {
  hash: string;
  media_type: string;
  bytes: Buffer;
}

export interface BrandImageFacts {
  hash: string;
  media_type: string;
  byte_size: number;
}

export async function internBrandImage(tenantId: string, image: BrandImage): Promise<void> {
  await getSequelize().query(
    `INSERT INTO brand_images (tenant_id, hash, media_type, bytes)
     VALUES (:tenantId, :hash, :mediaType, :bytes)
     ON CONFLICT (tenant_id, hash) DO NOTHING`,
    {
      type: QueryTypes.INSERT,
      replacements: {
        tenantId,
        hash: image.hash,
        mediaType: image.mediaType,
        bytes: image.bytes,
      },
    },
  );
}

export async function brandImagesByHash(
  tenantId: string,
  hashes: string[],
): Promise<Map<string, StoredBrandImage>> {
  const wanted = [...new Set(hashes)];
  if (wanted.length === 0) return new Map();

  const rows = await getSequelize().query<StoredBrandImage>(
    `SELECT hash, media_type, bytes
       FROM brand_images
      WHERE tenant_id = :tenantId AND hash IN (:hashes)`,
    { type: QueryTypes.SELECT, replacements: { tenantId, hashes: wanted } },
  );
  return new Map(rows.map((row) => [row.hash, row]));
}

export async function brandImageFactsByHash(
  tenantId: string,
  hashes: string[],
): Promise<Map<string, BrandImageFacts>> {
  const wanted = [...new Set(hashes)];
  if (wanted.length === 0) return new Map();

  const rows = await getSequelize().query<BrandImageFacts>(
    `SELECT hash, media_type, octet_length(bytes) AS byte_size
       FROM brand_images
      WHERE tenant_id = :tenantId AND hash IN (:hashes)`,
    { type: QueryTypes.SELECT, replacements: { tenantId, hashes: wanted } },
  );
  return new Map(rows.map((row) => [row.hash, row]));
}

/**
 * Brand images will stay for this long even after no config references it
 */
export const BRAND_SWEEP_GRACE_SECONDS = 24 * 60 * 60;

export async function sweepBrandImages(
  tenantId: string,
  keep: string[],
  graceSeconds: number = BRAND_SWEEP_GRACE_SECONDS,
): Promise<number> {
  const deleted = await getSequelize().query<{ hash: string }>(
    `DELETE FROM brand_images bi
      WHERE bi.tenant_id = :tenantId
        AND bi.created_at < now() - make_interval(secs => :graceSeconds)
        AND NOT (bi.hash = ANY(string_to_array(:keep, ',')))
        AND NOT EXISTS (
              SELECT 1 FROM instance_configs ic
               WHERE ic.tenant_id = bi.tenant_id
                 AND position(bi.hash in ic.yaml) > 0
            )
      RETURNING bi.hash`,
    {
      type: QueryTypes.SELECT,
      replacements: { tenantId, graceSeconds, keep: keep.join(',') },
    },
  );
  return deleted.length;
}

export async function brandImageExists(tenantId: string, hash: string): Promise<boolean> {
  const rows = await getSequelize().query<{ one: number }>(
    `SELECT 1 AS one FROM brand_images WHERE tenant_id = :tenantId AND hash = :hash`,
    { type: QueryTypes.SELECT, replacements: { tenantId, hash } },
  );
  return rows.length > 0;
}
