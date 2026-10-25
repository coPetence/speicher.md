/**
 * Lucide icons, resolved by kebab-case name and rendered as SVG
 *
 * Frontmatter names an icon in kebab-case while lucide exports the same nodes under
 * PascalCase keys; both spellings collide on a squashed (hyphen-free) name
 *
 * An icon is emitted as a <symbol> in a hidden sprite the page reuses with <use>, or as
 * a standalone inline <svg>. Both paths keep only an allowlist of shape elements and
 * attributes, so no script, style or event handler survives
 */
import { nearestName } from '../common/edit-distance';

type IconNode = [tag: string, attrs: Record<string, string | number>];

const ALLOWED_ELEMENTS = new Set([
  'circle',
  'ellipse',
  'line',
  'path',
  'polygon',
  'polyline',
  'rect',
]);
const ALLOWED_ATTRIBUTES = new Set([
  'cx',
  'cy',
  'd',
  'fill',
  'height',
  'points',
  'r',
  'rx',
  'ry',
  'width',
  'x',
  'x1',
  'x2',
  'y',
  'y1',
  'y2',
]);

interface IconSet {
  /** Built and keyed by squashed name */
  shapes: Map<string, IconNode[]>;
  /** Kebab-case names, sorted once at build */
  names: string[];
}

/** The lucide index, built on first use and kept for the process lifetime */
let iconSet: IconSet | null = null;
/** Rendered <symbol> per icon name, so repeat pages skip re-rendering */
const symbolCache = new Map<string, string>();

/** Strips hyphens and lowercases so kebab-case and PascalCase map to one key */
function squash(name: string): string {
  return name.replace(/-/g, '').toLowerCase();
}

/** Converts a PascalCase lucide key to kebab-case */
function kebab(name: string): string {
  return (
    name
      // letter/digit then capital: hyphen there, Group 1 the run, Group 2 the capital
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      // capital then capital+lowercase: Group 2 is the start of the next word run
      .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
      // letter then digit: Group 2 is the digit
      .replace(/([a-z])(\d)/g, '$1-$2')
      .toLowerCase()
  );
}

/** Loads lucide once and indexes each icon under both name forms */
function load(): IconSet {
  if (iconSet) return iconSet;
  // Required lazily: an icon-less instance should not parse lucide at startup
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { icons } = require('lucide') as { icons: Record<string, IconNode[]> };

  const shapes = new Map<string, IconNode[]>();
  const names: string[] = [];
  for (const [pascal, nodes] of Object.entries(icons)) {
    shapes.set(squash(pascal), nodes);
    names.push(kebab(pascal));
  }
  iconSet = { shapes, names: names.sort() };
  return iconSet;
}

/** The only accepted spelling: lowercase kebab-case, no double hyphens */
const ICON_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** True when name is a valid kebab-case name of an icon lucide ships */
export function iconExists(name: string): boolean {
  if (!ICON_NAME.test(name)) return false;
  return load().shapes.has(squash(name));
}

/** Every icon name lucide ships, sorted */
export function iconNames(): string[] {
  return [...load().names];
}

/** The name within two edits of name for a typo hint, or null */
export function suggestIcon(name: string): string | null {
  return nearestName(name, load().names, { ignoreCase: true });
}

/** The allowlisted shape markup for an icon, or null when name has no match */
function shapesFor(name: string): string | null {
  const nodes = load().shapes.get(squash(name));
  if (!nodes) return null;

  return nodes
    .filter(([tag]) => ALLOWED_ELEMENTS.has(tag))
    .map(([tag, attrs]) => {
      const kept = Object.entries(attrs ?? {})
        .filter(([key]) => ALLOWED_ATTRIBUTES.has(key))
        .map(([key, value]) => `${key}="${escapeAttribute(String(value))}"`)
        .join(' ');
      return `<${tag}${kept ? ` ${kept}` : ''}/>`;
    })
    .join('');
}

/** Prefix of sprite symbol ids, kept distinct from provider-mark ids on the page */
export const SYMBOL_PREFIX = 'i-';

/** One <symbol> for an icon, cached per name; null for a name with no match */
function symbolFor(name: string): string | null {
  const cached = symbolCache.get(name);
  if (cached !== undefined) return cached;

  const shapes = shapesFor(name);
  if (shapes === null) return null;

  const symbol = `<symbol id="${SYMBOL_PREFIX}${name}" viewBox="0 0 24 24">${shapes}</symbol>`;
  symbolCache.set(name, symbol);
  return symbol;
}

/** Sprite with one <symbol> per distinct icon; empty string for none */
export function renderSprite(names: Iterable<string>): string {
  const distinct = [...new Set([...names].filter(Boolean))].sort();
  const symbols = distinct.map(symbolFor).filter((s): s is string => s !== null);
  if (symbols.length === 0) return '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" display="none" hidden aria-hidden="true">` +
    `${symbols.join('')}</svg>`
  );
}

/** Concatenated <symbol>s for the names, for callers that wrap them themselves */
export function symbolsFor(names: Iterable<string>): string {
  return [...new Set([...names].filter(Boolean))]
    .sort()
    .map(symbolFor)
    .filter((s): s is string => s !== null)
    .join('');
}

export const DEFAULT_BRAND_ICON = 'library';

export function renderIconDocument(name: string): string {
  const shapes = shapesFor(name);
  if (shapes === null) return '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ` +
    `stroke="#71717a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<style>@media (prefers-color-scheme: dark){:root{stroke:#a1a1aa}}</style>` +
    `${shapes}</svg>`
  );
}

/** Standalone <svg> of an icon, stroked in the surrounding text colour */
export function renderInlineIcon(name: string, className: string): string {
  const shapes = shapesFor(name);
  if (shapes === null) return '';
  return (
    `<svg class="${escapeAttribute(className)}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${shapes}</svg>`
  );
}

/**
 * The icon a row is drawn with when its author named none: a page is drawn as a
 * page and a folder as a folder, so every entry in a tree or a listing carries a
 * mark and the ones an author chose stand out by being different rather than by
 * being there at all. Decided at render, never stored — a stored default would
 * become an author's choice the day the default moves, and `icon: null` is the
 * fact that lets the folder-and-landing-page merge in the nav prefer whichever
 * of the two was named.
 */
export const DEFAULT_ICONS = { page: 'file-text', folder: 'folder', start: 'house' } as const;

/** The name a row is drawn with: its own icon, else the default for its kind */
export function iconOf(row: { icon: string | null | undefined; kind?: 'page' | 'folder' }): string {
  return row.icon || DEFAULT_ICONS[row.kind ?? 'page'];
}

/** Small <use> reference to the sprite symbol, for an icon beside text */
export function renderIconRef(name: string | null | undefined): string {
  if (!name || !iconExists(name)) return '';
  return (
    `<svg class="spr-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true"><use href="#${SYMBOL_PREFIX}${name}"/></svg>`
  );
}

/** Escapes &, " and < for an attribute value in generated markup */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
