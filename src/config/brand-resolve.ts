/**
 * Turning what the document says about a logo into the bytes of one
 *
 * A stored value is one of two things — a `data:` URI, or `sha256:<hash>` naming
 * a row in `brand_images` — and a reader of a config never gets to assume which:
 * every version written before the table existed holds the first, a hand-written
 * `file`-mode document may hold either, and a version an operator rolls back to
 * holds whatever it held when it was saved.
 *
 * So resolution is two passes. The first is synchronous and needs nothing but the
 * document, which is what makes `loadInstanceConfig` — called by the form on
 * every keystroke-sized round trip, and by the migration that builds a
 * `ConfigService` — still work exactly as it did. The second reaches the table,
 * and only a caller with a tenant can make it.
 *
 * Neither pass ever throws. A logo is presentation: an unresolvable reference
 * costs a header its picture and says so in the log, and the alternative — a
 * version that fails to load, falling the instance back to an older one — is a
 * cure enormously worse than the disease. See `loadActiveInstanceConfig`.
 */

import type { BrandField, BrandImage, BrandImageSpec } from './brand';
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
  /** The fields a picture was found for */
  images: BrandImages;
  /** Fields naming a row, and the hash each names, for the pass that can read it */
  pending: Map<BrandField, string>;
  /** Why a field that names something has no picture, one line each */
  problems: string[];
}

export const NO_BRAND_IMAGES: BrandResolution = {
  images: new Map(),
  pending: new Map(),
  problems: [],
};

/**
 * The first pass: everything the document carries within itself.
 *
 * A field holding a reference is left `pending` rather than reported as a
 * problem — in `file` mode nothing will ever resolve it, and that is a real
 * problem, but it is not this function's to decide. See `loadActiveInstanceConfig`.
 */
export function resolveBrandImages(config: InstanceConfig): BrandResolution {
  const images: BrandImages = new Map();
  const pending = new Map<BrandField, string>();
  const problems: string[] = [];

  for (const spec of BRAND_IMAGES) {
    const stored = config.brand?.[spec.field];
    if (stored === undefined) continue;

    const hash = parseBrandRef(stored);
    if (hash !== null) {
      pending.set(spec.field, hash);
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
    const spec = specFor(field);
    const row = rows.get(hash);
    if (!row) {
      problems.push(
        `\`${spec.key}\` names an image this instance does not have stored (${hash.slice(0, 12)}…)`,
      );
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

/**
 * Whether anything here needs the table, asked without decoding anything.
 *
 * What `file` mode uses to decide whether to go near the database at all: a
 * document holding its pictures inline — which is every `file`-mode document
 * written by hand — resolves completely without one, and should not acquire a
 * query at boot because a feature exists that it does not use.
 */
export function namesStoredBrandImage(config: InstanceConfig): boolean {
  return BRAND_IMAGES.some((spec) => {
    const stored = config.brand?.[spec.field];
    return stored !== undefined && parseBrandRef(stored) !== null;
  });
}

/**
 * Both passes, for a caller that has a tenant to ask.
 *
 * The first pass runs again here rather than being handed in: it is one base64
 * decode of at most 64 KB, it happens once per config a process adopts, and the
 * alternative is carrying a half-resolved intermediate through
 * `LoadedInstanceConfig` where every reader of that type would have to know not
 * to trust it.
 */
export async function resolveBrandImagesFor(
  tenantId: string,
  config: InstanceConfig,
): Promise<BrandResolution> {
  return attachStoredBrandImages(tenantId, resolveBrandImages(config));
}

function specFor(field: BrandField): BrandImageSpec {
  // The three specs are a closed list and `field` comes from it
  return BRAND_IMAGES.find((spec) => spec.field === field) as BrandImageSpec;
}
