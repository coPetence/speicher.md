/** Resolves brand images from local files, data URIs, or sha256 references to brand_images */
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
import { ConfigProblem, problem } from '../common/config-problems';
import { brandImageProblem } from './checks/general';

export type BrandImages = Map<BrandField, BrandImage>;

export interface BrandResolution {
  images: BrandImages;
  pending: Map<BrandField, string>;
  /** Image resolution errors */
  problems: ConfigProblem[];
}

export const NO_BRAND_IMAGES: BrandResolution = {
  images: new Map(),
  pending: new Map(),
  problems: [],
};

export function resolveBrandImages(config: InstanceConfig): BrandResolution {
  const images: BrandImages = new Map();
  const pending = new Map<BrandField, string>();
  const problems: ConfigProblem[] = [];

  for (const spec of BRAND_IMAGES) {
    const stored = config.brand?.[spec.field];
    if (stored === undefined) continue;

    const referencedHash = parseBrandRef(stored);
    if (referencedHash !== null) {
      pending.set(spec.field, referencedHash);
      continue;
    }

    const { image, problem: invalid } = parseBrandImage(stored, spec);
    if (image) images.set(spec.field, image);
    else if (invalid) problems.push(brandImageProblem(spec.key, invalid));
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
      problems.push(
        problem('brand.image-invalid', `brand.${field}`, {
          text: 'is not a valid brand image field',
          dashboard: 'Invalid brand image field.',
        }),
      );
      continue;
    }

    if (!row) {
      problems.push(
        problem('brand.image-not-stored', spec.key, {
          text: `references a missing image (${hash}); upload it again`,
          dashboard: 'Image not found on this instance. Upload it again.',
        }),
      );
      continue;
    }

    const extension = spec.types[row.media_type];
    if (extension === undefined) {
      problems.push(
        problem('brand.image-invalid', spec.key, {
          text: `has unsupported image type ${row.media_type}; use ${Object.keys(spec.types).join(', ')}`,
          dashboard: `Unsupported image type: ${row.media_type}. Use ${Object.keys(spec.types).join(', ')}.`,
        }),
      );
      continue;
    }

    const invalid = checkBrandBytes(row.bytes, row.media_type, spec);
    if (invalid) {
      problems.push(brandImageProblem(spec.key, invalid));
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
