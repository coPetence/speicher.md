/**
 * Slug utilities for content paths
 *
 * Transforms names and directory paths into URL-safe slugs, with numeric prefix
 * extraction for ordering. Also provides path manipulation for the slug routing scheme.
 *
 * Numeric prefixes are 1-3 digits followed by a separator. A 4-digit number is not one.
 * German umlauts are transliterated (ä→ae, ö→oe, ü→ue, ß→ss) rather than dropped.
 */

export function splitNumericPrefix(name: string): { order: number | null; rest: string } {
  // Matches a 1-3 digit prefix followed by a separator, extracts the number (Group 1)
  // and the remainder (Group 2)
  const match = /^(\d{1,3})[-_. ]+(.*)$/.exec(name);
  if (!match || match[2].length === 0) return { order: null, rest: name };
  return { order: Number(match[1]), rest: match[2] };
}

const TRANSLITERATE: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  Ä: 'ae',
  Ö: 'oe',
  Ü: 'ue',
  ß: 'ss',
};

export function slugify(input: string): string {
  const folded = input.replace(/[äöüÄÖÜß]/g, (c) => TRANSLITERATE[c]);
  return folded
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function deslugify(slug: string): string {
  const words = slug.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return slug;
  return words.join(' ').replace(/^./, (c) => c.toUpperCase());
}

export const RESERVED_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  '-',
  'api',
  'auth',
  'mcp',
  '.',
  '..',
]);

export function isReservedSegment(raw: string): boolean {
  if (RESERVED_FIRST_SEGMENTS.has(raw)) return true;
  const normalized = slugify(raw);

  if (normalized.length === 0) return true;
  return RESERVED_FIRST_SEGMENTS.has(normalized);
}

export function splitPath(path: string): string[] | null {
  const segments = path.split('/').filter((s) => s.length > 0);
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return null;
    if (segment.includes('\0')) return null;
  }
  return segments;
}

export function normalizeSlugPath(path: string): string {
  return path.split('/').filter(Boolean).join('/');
}

export function joinSlugPath(...parts: (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join('/')
    .split('/')
    .filter(Boolean)
    .join('/');
}

export function parentSlugPath(slugPath: string): string | null {
  const normalized = normalizeSlugPath(slugPath);
  if (normalized === '') return null;
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? '' : normalized.slice(0, idx);
}
