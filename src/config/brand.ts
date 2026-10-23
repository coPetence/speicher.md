import { createHash } from 'node:crypto';

export const MAX_BRAND_LOGO_BYTES = 64 * 1024;
export const MAX_BRAND_ICON_BYTES = 32 * 1024;
export const MAX_BRAND_WALLPAPER_BYTES = 5 * 1024 * 1024;
export const MIN_BRAND_ICON_PIXELS = 32;

/** Media types a logo may have, mapped to the extension its file gets */
export const BRAND_LOGO_TYPES: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const BRAND_ICON_TYPES: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
};

export const BRAND_WALLPAPER_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/** The keys under `brand` that hold a picture */
export type BrandField = 'logo' | 'logo_dark' | 'icon' | 'wallpaper' | 'wallpaper_dark';

/** What an image at one of the brand keys may be */
export interface BrandImageSpec {
  /** The key under `brand`, where its stored */
  field: BrandField;
  key: string;
  /** Accepted media types */
  types: Record<string, string>;
  maxBytes: number;
  square?: boolean;
}

export const BRAND_LOGO: BrandImageSpec = {
  field: 'logo',
  key: 'brand.logo',
  types: BRAND_LOGO_TYPES,
  maxBytes: MAX_BRAND_LOGO_BYTES,
};

export const BRAND_LOGO_DARK: BrandImageSpec = {
  field: 'logo_dark',
  key: 'brand.logo_dark',
  types: BRAND_LOGO_TYPES,
  maxBytes: MAX_BRAND_LOGO_BYTES,
};

export const BRAND_ICON: BrandImageSpec = {
  field: 'icon',
  key: 'brand.icon',
  types: BRAND_ICON_TYPES,
  maxBytes: MAX_BRAND_ICON_BYTES,
  square: true,
};

export const BRAND_WALLPAPER: BrandImageSpec = {
  field: 'wallpaper',
  key: 'brand.wallpaper',
  types: BRAND_WALLPAPER_TYPES,
  maxBytes: MAX_BRAND_WALLPAPER_BYTES,
};

export const BRAND_WALLPAPER_DARK: BrandImageSpec = {
  field: 'wallpaper_dark',
  key: 'brand.wallpaper_dark',
  types: BRAND_WALLPAPER_TYPES,
  maxBytes: MAX_BRAND_WALLPAPER_BYTES,
};

export const BRAND_IMAGES: BrandImageSpec[] = [
  BRAND_LOGO,
  BRAND_LOGO_DARK,
  BRAND_ICON,
  BRAND_WALLPAPER,
  BRAND_WALLPAPER_DARK,
];

/** The largest file any brand image may be, which is what an upload is capped at */
export const MAX_BRAND_IMAGE_BYTES = Math.max(...BRAND_IMAGES.map((spec) => spec.maxBytes));

export interface BrandImage {
  mediaType: string;
  bytes: Buffer;

  /** SHA-256 of the bytes, lower hex. The key the `brand_images` row is stored under */
  hash: string;

  file: string; // Content-addressed: the hash plus the extension of its type
}

export function brandImageUrl(image: BrandImage): string {
  return `/-/brand/${image.file}`;
}

export const BRAND_REF_PREFIX = 'sha256:';

export function brandRef(image: BrandImage): string {
  return `${BRAND_REF_PREFIX}${image.hash}`;
}

// Matches a stored reference and nothing else: the prefix and 64 lower-hex digits
const BRAND_REF = /^sha256:([0-9a-f]{64})$/;

export function parseBrandRef(value: string): string | null {
  return BRAND_REF.exec(value.trim())?.[1] ?? null;
}

export function brandValueKind(value: string): 'ref' | 'data' | 'unknown' {
  if (parseBrandRef(value) !== null) return 'ref';
  return splitDataUri(value) ? 'data' : 'unknown';
}

// Matches the head of a `data:` URI: media type (Group 1)
const DATA_URI_HEAD = /^data:([a-z+/-]+);base64,/;

/**
 * Splits a `data:` URI into its media type and base64 payload
 *
 * Only the head is matched with a pattern: a payload of several megabytes
 * overflows the regex engine's stack
 */
function splitDataUri(value: string): { mediaType: string; base64: string } | null {
  const trimmed = value.trim();
  const head = DATA_URI_HEAD.exec(trimmed.slice(0, 64));
  if (!head) return null;
  const base64 = trimmed.slice(head[0].length);
  return base64 === '' ? null : { mediaType: head[1], base64 };
}

/** Features that could run script or reach out, each refused with its why */
const SVG_REFUSALS: { test: (svg: string) => boolean; why: string }[] = [
  { test: (svg) => /<script[\s>]/i.test(svg), why: 'contains a <script> element' },
  { test: (svg) => /<foreignObject[\s>]/i.test(svg), why: 'contains a <foreignObject> element' },

  { test: (svg) => /<!entity/i.test(svg), why: 'declares an entity' },
  { test: hasInternalSubset, why: 'carries a doctype with an internal subset' },
  { test: (svg) => /\son[a-z]+\s*=/i.test(svg), why: 'carries an inline event handler' },
  { test: (svg) => /@import/i.test(svg), why: 'imports a stylesheet' },
  {
    test: (svg) => outwardReferences(svg).length > 0,
    why: 'references something outside itself',
  },
];

/** Whether the doctype carries its entity subset in brackets */
function hasInternalSubset(svg: string): boolean {
  const at = svg.search(/<!doctype/i);
  if (at < 0) return false;
  const rest = svg.slice(at);
  const bracket = rest.indexOf('[');
  const close = rest.indexOf('>');
  return bracket !== -1 && (close === -1 || bracket < close);
}

/** URLs an SVG reaches out to, excluding in-file `#` fragments */
function outwardReferences(svg: string): string[] {
  const targets: string[] = [];
  const collect = (pattern: RegExp) => {
    for (const match of svg.matchAll(pattern)) {
      targets.push((match[2] ?? match[3] ?? match[4] ?? '').trim());
    }
  };

  // Matches `href` (optionally `xlink:href`); groups 2-4 are the DQ, SQ or bare target
  collect(/(?:xlink:)?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi);

  // Matches `url(...)`; groups 2-4 are the DQ, SQ or bare target
  collect(/url\s*\(\s*("([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi);
  return targets.filter((target) => !target.startsWith('#'));
}

export interface BrandImageResult {
  image: BrandImage | null;
  problem: string | null; // Human-readable reason the image was refused
}

export function parseBrandImage(value: string, spec: BrandImageSpec): BrandImageResult {
  const parts = splitDataUri(value);
  if (!parts) {
    return {
      image: null,
      problem: `\`${spec.key}\` must be a base64 \`data:\` URI`,
    };
  }

  const { mediaType, base64 } = parts;
  const extension = spec.types[mediaType];
  if (!extension) {
    return {
      image: null,
      problem: `\`${spec.key}\` is ${mediaType}; it must be one of ${Object.keys(spec.types).join(', ')}`,
    };
  }

  const bytes = Buffer.from(base64, 'base64');

  // Buffer.from tolerates stray characters, so re-encode to catch malformed base64
  if (bytes.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')) {
    return { image: null, problem: `\`${spec.key}\` is not valid base64` };
  }
  const problem = checkBrandBytes(bytes, mediaType, spec);
  if (problem) return { image: null, problem };

  return { image: brandImageOf(bytes, mediaType, extension), problem: null };
}

export function checkBrandBytes(
  bytes: Buffer,
  mediaType: string,
  spec: BrandImageSpec,
): string | null {
  if (bytes.length === 0) return `\`${spec.key}\` is corrupted`;
  if (bytes.length > spec.maxBytes) {
    return `\`${spec.key}\` is ${describeBytes(bytes.length)}; the limit is ${describeBytes(spec.maxBytes)}`;
  }

  const sniffed = sniffMediaType(bytes);
  if (sniffed !== mediaType) {
    return sniffed
      ? `\`${spec.key}\` says ${mediaType} but the bytes are ${sniffed}`
      : `\`${spec.key}\` says ${mediaType} but the bytes are not a JPEG, a PNG, a WebP or an SVG`;
  }

  if (mediaType === 'image/svg+xml') {
    const svg = bytes.toString('utf8');
    for (const { test, why } of SVG_REFUSALS) {
      if (test(svg)) return `\`${spec.key}\`: the SVG ${why}, which is not allowed`;
    }
  }

  if (spec.square === true) return checkSquare(bytes, mediaType, spec.key);
  return null;
}

/** An image from bytes already known to be acceptable, named by their hash */
export function brandImageOf(bytes: Buffer, mediaType: string, extension: string): BrandImage {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return { mediaType, bytes, hash, file: `${hash}.${extension}` };
}

function checkSquare(bytes: Buffer, mediaType: string, key: string): string | null {
  const size = mediaType === 'image/png' ? pngSize(bytes) : svgSize(bytes.toString('utf8'));

  if (!size) return null;

  const { width, height } = size;

  // gives 10% tolerance on the longer edge
  if (Math.abs(width - height) > Math.max(width, height) / 10) {
    return `\`${key}\` is ${width}×${height}; it has to be a square`;
  }
  if (mediaType === 'image/png' && Math.min(width, height) < MIN_BRAND_ICON_PIXELS) {
    return (
      `\`${key}\` is ${width}×${height}; a favicon needs to be at least ` +
      `${MIN_BRAND_ICON_PIXELS}×${MIN_BRAND_ICON_PIXELS}`
    );
  }
  return null;
}

interface ImageSize {
  width: number;
  height: number;
}

function pngSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 24 || bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** SVG proportions: `viewBox`, else `width` and `height` */
function svgSize(svg: string): ImageSize | null {
  const head = svg.slice(0, 1024);

  const viewBox =
    /viewBox\s*=\s*["']\s*([-\d.eE+]+)[,\s]+([-\d.eE+]+)[,\s]+([-\d.eE+]+)[,\s]+([-\d.eE+]+)/.exec(
      head,
    );
  if (viewBox) {
    const width = Number(viewBox[3]);
    const height = Number(viewBox[4]);
    if (width > 0 && height > 0) return { width, height };
  }

  const length = (attribute: string): number => {
    const found = new RegExp(`\\s${attribute}\\s*=\\s*["']\\s*([\\d.]+)`).exec(head);
    return found ? Number(found[1]) : 0;
  };
  const width = length('width');
  const height = length('height');
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Detect an image's real format from its bytes, not its claimed config type */
export function sniffMediaType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_MAGIC)) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }

  const head = bytes
    .subarray(0, 1024)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();

  // SVG may open with a declaration, comment or doctype, so seek an `<svg` root
  if (/^(<\?xml[\s?]|<!--|<!doctype|<svg[\s>])/i.test(head) && /<svg[\s>]/i.test(head)) {
    return 'image/svg+xml';
  }
  return null;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** Human-friendly byte count for messages: `N bytes`, `N KB` or `N MB` */
export function describeBytes(count: number): string {
  if (count < 1024) return `${count} bytes`;
  if (count < 1024 * 1024) return `${Math.round(count / 1024)} KB`;
  return `${Number((count / (1024 * 1024)).toFixed(1))} MB`;
}
