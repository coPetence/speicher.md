/**
 * Brand logo from the instance configuration
 *
 * `brand.logo` holds a base64 `data:` URI written by the config form from an upload
 * A configuration loads only when its logo parses; a served logo has passed the checks
 * The served file name is a hash of the bytes, addressed under the `-/brand` route
 *
 * SVG is treated as untrusted markup and refused unless it survives SVG_REFUSALS
 */

import { createHash } from 'node:crypto';

/** Cap on a logo: every saved version of the configuration carries a copy */
export const MAX_BRAND_LOGO_BYTES = 64 * 1024;

/** Media types a logo may have, mapped to the extension its file gets */
export const BRAND_LOGO_TYPES: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface BrandLogo {
  mediaType: string;
  bytes: Buffer;

  file: string; // Content-addressed: SHA-256 prefix plus extension
}

/** URL the logo is served at, under the assets controller's `-/brand` route */
export function brandLogoUrl(logo: BrandLogo): string {
  return `/-/brand/${logo.file}`;
}

// Matches `data:` URIs: media type (Group 1), base64 payload (Group 2)
const DATA_URI = /^data:([a-z+/-]+);base64,([A-Za-z0-9+/]+={0,2})$/;

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

export interface BrandLogoResult {
  logo: BrandLogo | null;

  problem: string | null; // Human-readable reason the logo was refused
}

/** Validate a `brand.logo` value into a servable logo, or say why it is refused
 *
 * Checks the data-URI shape, the media whitelist, valid base64, the size cap,
 * that the bytes match the claimed type, and SVG against SVG_REFUSALS
 */
export function parseBrandLogo(value: string): BrandLogoResult {
  const match = DATA_URI.exec(value.trim());
  if (!match) {
    return {
      logo: null,
      problem: '`brand.logo` must be a base64 `data:` URI — the form writes one from an upload',
    };
  }

  const [, mediaType, base64] = match;
  const extension = BRAND_LOGO_TYPES[mediaType];
  if (!extension) {
    return {
      logo: null,
      problem: `\`brand.logo\` is ${mediaType}; it must be one of ${Object.keys(BRAND_LOGO_TYPES).join(', ')}`,
    };
  }

  const bytes = Buffer.from(base64, 'base64');

  // Buffer.from tolerates stray characters, so re-encode to catch malformed base64
  if (bytes.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')) {
    return { logo: null, problem: '`brand.logo` is not valid base64' };
  }
  if (bytes.length === 0) {
    return { logo: null, problem: '`brand.logo` decodes to nothing' };
  }
  if (bytes.length > MAX_BRAND_LOGO_BYTES) {
    return {
      logo: null,
      problem: `\`brand.logo\` is ${describeBytes(bytes.length)}; the limit is ${describeBytes(MAX_BRAND_LOGO_BYTES)}, because every saved version of this configuration carries a copy`,
    };
  }

  const sniffed = sniffMediaType(bytes);
  if (sniffed !== mediaType) {
    return {
      logo: null,
      problem: sniffed
        ? `\`brand.logo\` says ${mediaType} but the bytes are ${sniffed}`
        : `\`brand.logo\` says ${mediaType} but the bytes are not a PNG, a WebP or an SVG`,
    };
  }

  if (mediaType === 'image/svg+xml') {
    const svg = bytes.toString('utf8');
    for (const { test, why } of SVG_REFUSALS) {
      if (test(svg)) {
        return { logo: null, problem: `\`brand.logo\`: the SVG ${why}, which is refused` };
      }
    }
  }

  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  return { logo: { mediaType, bytes, file: `${hash}.${extension}` }, problem: null };
}

/** Detect a logo's real format from its bytes, not its claimed config type */
export function sniffMediaType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
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

/** Human-friendly byte count for messages: `N bytes` or `N KB` */
export function describeBytes(count: number): string {
  return count < 1024 ? `${count} bytes` : `${Math.round(count / 1024)} KB`;
}
