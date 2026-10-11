/**
 * The `brand_images` table: where the bytes of a logo live
 *
 * A row is named by the SHA-256 of its own bytes, so writing is idempotent and
 * the same image uploaded twice is the same row. The document refers to a row by
 * `sha256:<hash>` — see `brandRef` — and nothing here knows which of the three
 * brand keys, or which config version, is pointing at it.
 *
 * Rows are never updated and never deleted while any stored config version still
 * names them: `instance_configs` appends, and a version an operator rolls back to
 * has to still find its picture. What is collected is the orphan — a row interned
 * by a save that was then refused or abandoned.
 */

import { QueryTypes } from 'sequelize';

import { getSequelize } from '../db/sequelize';
import type { BrandImage } from './brand';

/** What a row holds, beyond the hash it is keyed by */
export interface StoredBrandImage {
  hash: string;
  media_type: string;
  bytes: Buffer;
}

/**
 * Store the bytes, or notice they are already stored.
 *
 * `DO NOTHING` rather than an update: the key *is* the bytes, so a row that
 * exists already holds exactly what this would have written.
 */
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

/**
 * The rows for the hashes given, keyed by hash.
 *
 * One query for all three brand keys, because resolving a config is one step and
 * two of the three usually point at nothing. Hashes the table does not have are
 * simply absent from the map; it is the caller that knows whether that is worth
 * reporting.
 */
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

/** What an image is, in the two facts a page says out loud */
export interface BrandImageFacts {
  hash: string;
  media_type: string;
  /** Size in bytes, asked of the column so the bytes themselves stay in the database */
  byte_size: number;
}

/**
 * The type and size of stored images, without fetching them.
 *
 * What the settings page needs to write "PNG, 2 KB" beside a picker. The bytes
 * are deliberately left behind: three logos on a page that is rendered on every
 * round trip of the form is three reads of up to 64 KB for two facts.
 */
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
 * How long a row nothing points at is left alone.
 *
 * An upload is stored the moment it is accepted, which is before the save that
 * would name it — a form whose Add and Remove are round trips cannot work any
 * other way. So between the two there is a window in which the only thing
 * referring to an image is a page on somebody's screen, and that window is what
 * this is: long enough to write a configuration with it, short enough that an
 * abandoned attempt does not stay forever.
 */
export const BRAND_SWEEP_GRACE_SECONDS = 24 * 60 * 60;

/**
 * Collect images nothing refers to any more.
 *
 * `instance_configs` appends and never prunes, and a restore replays an old
 * version's document as it was written — so an image is deletable only when *no*
 * stored version names it. Asked of the versions' own text rather than of a
 * reference count, because the document is where a reference lives: there is no
 * second place to keep in step with it, and a 64-character hash does not occur
 * in a configuration by accident.
 *
 * `keep` is what the running configuration names, which the versions may not
 * say: in `file` mode the document is a file and the table of versions can be
 * empty, and a version that failed to load is still the picture on every page.
 */
export async function sweepBrandImages(
  tenantId: string,
  keep: string[],
  graceSeconds: number = BRAND_SWEEP_GRACE_SECONDS,
): Promise<number> {
  // `RETURNING` and a SELECT, so the count is the rows themselves rather than
  // whatever shape the driver reports for a DELETE
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

/** Whether this tenant holds a row for the hash, without reading the bytes */
export async function brandImageExists(tenantId: string, hash: string): Promise<boolean> {
  const rows = await getSequelize().query<{ one: number }>(
    `SELECT 1 AS one FROM brand_images WHERE tenant_id = :tenantId AND hash = :hash`,
    { type: QueryTypes.SELECT, replacements: { tenantId, hash } },
  );
  return rows.length > 0;
}
