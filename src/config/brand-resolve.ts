/**
 * The config can store brand images in 3 formats:
 *  - Reference to a local file
 *  - `data:` URI
 *  - `sha256:<hash>` -> reference to image in stored in `brand_images` db table
 *
 * This file reosolved all of them
 */

import type { BrandField, BrandImage } from './brand';
import {
  BRAND_IMAGES,
  brandImageOf,
  checkBrandBytes,
  parseBrandImage,
  parseBrandRef,
} from './brand';
import { brandImagesByHash } from './brand-store';
import type { InstanceConfig } from './types';

export type BrandImages = Map<BrandField, BrandImage>;

export interface BrandResolution {
  images: BrandImages;
  pending: Map<BrandField, string>;
  /** Problems while resolving images */
  problems: string[];
}

export const NO_BRAND_IMAGES: BrandResolution = {
  images: new Map(),
  pending: new Map(),
  problems: [],
};

export function resolveBrandImages(config: InstanceConfig): BrandResolution {
  const images: BrandImages = new Map();
  const pending = new Map<BrandField, string>();
  const problems: string[] = [];

  for (const spec of BRAND_IMAGES) {
    const stored = config.brand?.[spec.field];
    if (stored === undefined) continue;

    const referencedHash = parseBrandRef(stored);
    if (referencedHash !== null) {
      pending.set(spec.field, referencedHash);
      continue;
    }

    const { image, problem } = parseBrandImage(stored, spec);
    if (image) images.set(spec.field, image);
    else if (problem) problems.push(problem);
  }

  return { images, pending, problems };
}

export async function attachStoredBrandImages(
  tenantId: string,
  resolution: BrandResolution,
): Promise<BrandResolution> {
  if (resolution.pending.size === 0) return resolution;

  const images: BrandImages = new Map(resolution.images);
  const problems = [...resolution.problems];
  const rows = await brandImagesByHash(tenantId, [...resolution.pending.values()]);

  for (const [field, hash] of resolution.pending) {
    const spec = BRAND_IMAGES.find((spec) => spec.field === field);
    const row = rows.get(hash);

    if (!spec) {
      problems.push(`\`brand.${field}\` is not a brand image`);
      continue;
    }

    if (!row) {
      problems.push(`\`${spec.key}\` names an image this instance does not have stored (${hash})`);
      continue;
    }

    const extension = spec.types[row.media_type];
    if (extension === undefined) {
      problems.push(
        `\`${spec.key}\` names a ${row.media_type} image; it must be one of ${Object.keys(spec.types).join(', ')}`,
      );
      continue;
    }

    const problem = checkBrandBytes(row.bytes, row.media_type, spec);
    if (problem) {
      problems.push(problem);
      continue;
    }

    images.set(field, brandImageOf(row.bytes, row.media_type, extension));
  }

  return { images, pending: new Map(), problems };
}

export function instanceConfigHasBrandImageRefs(config: InstanceConfig): boolean {
  return BRAND_IMAGES.some((spec) => {
    const stored = config.brand?.[spec.field];
    return stored !== undefined && parseBrandRef(stored) !== null;
  });
}

export async function resolveBrandImagesForTenantId(
  tenantId: string,
  config: InstanceConfig,
): Promise<BrandResolution> {
  return attachStoredBrandImages(tenantId, resolveBrandImages(config));
}
