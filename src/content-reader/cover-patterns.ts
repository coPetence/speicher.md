/**
 * Deterministic SVG tile patterns for repository cover art
 *
 * Each repo gets the same pattern every time, selected by hashing its key
 *
 * The SVG paints in `currentColor`; the stylesheet controls colour and opacity
 * through `--spr-cover-mark` / `--spr-cover-mark-opacity`
 *
 * Patterns tile at their natural pixel size via `patternUnits="userSpaceOnUse"`
 * (no viewBox, so CSS pixels are the unit)
 */

/** Describes one SVG pattern tile */
export interface CoverPattern {
  name: string;

  width: number;
  height: number;

  linecap?: 'square'; // Square linecap to close gaps at tile boundaries
  d: string;
}

/** The eight patterns shipped with the design system */
export const COVER_PATTERNS: CoverPattern[] = [
  {
    name: 'crosses',
    width: 20,
    height: 20,
    linecap: 'square',
    d: 'M10-6V6m0 8v12m16-16H14m-8 0H-6',
  },
  {
    name: 'chevrons',
    width: 40,
    height: 20,
    d: 'M40 0 20-10V0l20 10zm0 10L20 0v10l20 10zm0 10L20 10v10l20 10zM0 20l20-10v10L0 30zm0-10L20 0v10L0 20zM0 0l20-10V0L0 10z',
  },
  {
    name: 'weave',
    width: 40,
    height: 40,
    d: 'M15 5h10v30H15zM35-5V5H5V-5zm0 40v10H5V35zm0-50h10v30H35zm20 30v10H25V15zm-40 0v10h-30V15zm20 10h10v30H35zm-40 0H5v30H-5zm0-40H5v30H-5z',
  },
  {
    name: 'dots',
    width: 20,
    height: 20,
    d: 'M10 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z',
  },
  {
    name: 'isometric',
    width: 58,
    height: 100.23,
    linecap: 'square',
    d: 'm12.127 73.813.013 5.643 4.893-2.81zm-6.01-3.47 16.928 9.773-16.93 9.777zm-6.02-3.476 28.967 16.725L.13 100.262zm16.97 23.616-.015 5.643-4.893-2.81zm6.01-3.472L6.148 96.786l16.93 9.776zM.128 100.261l28.935 16.669m16.874-23.67-.013-5.644-4.894 2.81zm6.01 3.47L35.02 86.956l16.931-9.775zM29 83.482l28.936-16.669.032 33.393m-28.904 2.834 4.881-2.834-4.88-2.832zm0 6.94V90.433l16.932 9.773zm0 6.952v-33.45l28.904 16.724zM58 13.915l-4.882 2.833L58 19.582zm0-6.94v19.548l-16.932-9.774zm0-6.951v33.448L29.096 16.748m0-13.89 4.88-2.833-4.88-2.833zm0 6.94V-9.749L46.026.025zm0 6.95v-33.449L58 .024zM16.94 23.696l-4.894-2.81-.014 5.643zm6.01-3.47L6.02 29.998v-19.55zM0 33.472.033.08 28.97 16.75m-5.99-29.92L6.053-3.393l16.93 9.776zm5.99 29.92L29-16.644.033.08m40.966 23.615.013 5.643 4.893-2.81zm-6.01-3.47 16.928 9.774-16.93 9.775zm22.947 13.248L29 50.143l-.031-33.394M16.97 43.197l-.013-5.643-4.894 2.81zm6.01 3.47L6.053 36.894l16.93-9.776zM29 50.143.032 33.419l28.936-16.67m16.937 57.008-4.893-2.81-.014 5.644zm6.01-3.47L34.988 80.06V60.51zM29 64.035l-4.88 2.832L29 69.7zm0-6.942v19.549l-16.93-9.775zM.097 66.867 29 50.143v33.449m16.938-43.228-.013 5.644-4.894-2.811zm6.01-3.47L35.02 46.667l16.931 9.777zM29 50.143l28.936 16.67.032-33.394M.097 52.975l4.88-2.832-4.88-2.833zm0 6.942V40.368l16.931 9.775zm0 6.95V33.42',
  },
  {
    name: 'scales',
    width: 20,
    height: 20,
    d: 'M-10-10A10 10 0 0 0-20 0a10 10 0 0 0 10 10A10 10 0 0 1 0 0a10 10 0 0 0-10-10zm20 0A10 10 0 0 0 0 0a10 10 0 0 1 10 10A10 10 0 0 1 20 0a10 10 0 0 0-10-10zm20 0A10 10 0 0 0 20 0a10 10 0 0 1 10 10A10 10 0 0 1 40 0a10 10 0 0 0-10-10zm-40 20a10 10 0 0 0-10 10 10 10 0 0 0 10 10A10 10 0 0 1 0 20a10 10 0 0 0-10-10zm20 0A10 10 0 0 0 0 20a10 10 0 0 1 10 10 10 10 0 0 1 10-10 10 10 0 0 0-10-10zm20 0a10 10 0 0 0-10 10 10 10 0 0 1 10 10 10 10 0 0 1 10-10 10 10 0 0 0-10-10z',
  },
  {
    name: 'bricks',
    width: 30,
    height: 30,
    d: 'M0 22.5h30v15H0zm15-15h30v15H15m-30-15h30v15h-30zm15-15h30v15H0z',
  },
  {
    name: 'hexagons',
    width: 29,
    height: 50.115,
    linecap: 'square',
    d: 'M14.499 11.82 4.36 5.968l.002-11.706 10.14-5.855L24.638-5.74l-.001 11.707zm0 50.06L4.36 56.029l.002-11.706 10.14-5.855 10.137 5.852-.001 11.707zm14.498-25.117L18.858 30.91l.002-11.707L29 13.349l10.137 5.853-.001 11.706zm-29 0-10.139-5.852.002-11.707L0 13.349l10.138 5.853-.002 11.706zm14.501-19.905L0 8.488.002-8.257l14.5-8.374L29-8.26l-.002 16.745zm0 50.06L0 58.548l.002-16.745 14.5-8.373L29 41.8l-.002 16.744zM28.996 41.8l-14.498-8.37.002-16.744L29 8.312l14.498 8.37-.002 16.745zm-29 0-14.498-8.37.002-16.744L0 8.312l14.498 8.37-.002 16.745z',
  },
];

/** FNV-1a hash of the key, finalised by XOR-fold, selects a pattern by modulus */
export function coverPatternFor(key: string): CoverPattern {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);

    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }

  return COVER_PATTERNS[(((hash >>> 16) ^ hash) >>> 0) % COVER_PATTERNS.length];
}

/** Full SVG markup with a `<pattern>` fill for the repo identified by key */
export function renderCoverPattern(key: string, id: string): string {
  const pattern = coverPatternFor(key);
  const safeId = escapeAttribute(id);
  const linecap = pattern.linecap ? ` stroke-linecap="${pattern.linecap}"` : '';
  return (
    `<svg class="spr-cover-art" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" ` +
    `data-spr-pattern="${escapeAttribute(pattern.name)}">` +
    `<defs><pattern id="${safeId}" patternUnits="userSpaceOnUse" ` +
    `width="${pattern.width}" height="${pattern.height}">` +
    `<path d="${pattern.d}" fill="none" stroke="currentColor"${linecap}/>` +
    `</pattern></defs>` +
    `<rect width="100%" height="100%" fill="url(#${safeId})"/>` +
    `</svg>`
  );
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
