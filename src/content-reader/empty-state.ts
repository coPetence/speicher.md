/* User units of every drawing; */
const VIEW_BOX = '0 0 160 120';

const GROUND =
  '<ellipse cx="80" cy="111" rx="46" ry="3" fill="currentColor" stroke="none" opacity="0.1"/>';

const FLOATING =
  '<path d="M27 38v8M23 42h8" opacity="0.55"/>' +
  '<path d="M136 28v6M133 31h6" opacity="0.35"/>' +
  '<circle cx="134" cy="62" r="3" opacity="0.55"/>' +
  '<circle cx="22" cy="80" r="1" fill="currentColor" opacity="0.55"/>';

const TINT = 'fill="currentColor" fill-opacity="0.06"';

const BEHIND = 'opacity="0.45"';

const absent = (pathLength?: number): string =>
  'stroke-dasharray="1 6" opacity="0.55"' +
  (pathLength === undefined ? '' : ` pathLength="${pathLength}"`);

const DRAWINGS = {
  /** A sheet of paper: a heading, and the rows that would have been under it */
  page: [
    `<path d="M109 93h1a6 6 0 0 0 6-6V23a6 6 0 0 0-6-6H62a6 6 0 0 0-6 6" ${BEHIND}/>`,
    `<path d="M50 26h40l14 14v56a6 6 0 0 1-6 6H50a6 6 0 0 1-6-6V32a6 6 0 0 1 6-6z" ${TINT}/>`,
    '<path d="M90 26v8a6 6 0 0 0 6 6h8"/>',
    '<path d="M54 54h18"/>',
    `<path d="M54 66h40M54 77h40M54 88h26" ${absent()}/>`,
  ],

  /** A folder, and the branch nothing has been read from */
  sources: [
    `<path d="M50 26a6 6 0 0 1 6-6h17l8 9h35a6 6 0 0 1 6 6v49a6 6 0 0 1-6 6h-1" ${BEHIND}/>`,
    '<path d="M46 29h17l8 9h35a6 6 0 0 1 6 6v49a6 6 0 0 1-6 6H46a6 6 0 0 1-6-6V35' +
      `a6 6 0 0 1 6-6z" ${TINT}/>`,
    '<circle cx="62" cy="84" r="4"/>',
    '<circle cx="90" cy="56" r="4"/>',
    `<path d="M62 48v28" ${absent(29)}/>`,
    `<path d="M90 64a20 20 0 0 1-20 20" ${absent(29)}/>`,
  ],

  /** A shield, and the person who would hold it */
  admins: [
    '<path d="M79.7 20.7C80.9 19.9 82 19 83 18.1A4.6 4.6 0 0 1 89 18.1' +
      'C95.8 24 105.5 28.7 113.3 28.7A3.9 3.9 0 0 1 117.2 32.6V59.9' +
      `C117.2 76.4 107.5 85.9 94.6 91.9" ${BEHIND}/>`,
    '<path d="M105.2 63.9C105.2 83.4 91.5 93.2 75.3 98.8A3.9 3.9 0 0 1 72.7 98.8' +
      'C56.5 93.2 42.8 83.4 42.8 63.9V36.6A3.9 3.9 0 0 1 46.7 32.7' +
      'C54.5 32.7 64.2 28 71 22.1A4.6 4.6 0 0 1 77 22.1' +
      `C83.8 28 93.5 32.7 101.3 32.7A3.9 3.9 0 0 1 105.2 36.6z" ${TINT}/>`,
    `<circle cx="74" cy="51" r="7" ${absent(42)}/>`,
    `<path d="M60 80a14 14 0 0 1 28 0" ${absent(43)}/>`,
  ],

  /** A lock, and the keyhole nothing has opened yet */
  identity: [
    `<path d="M62 52V40a18 18 0 0 1 36 0v12" ${BEHIND}/>`,
    `<path d="M54 52h52a6 6 0 0 1 6 6v34a6 6 0 0 1-6 6H54a6 6 0 0 1-6-6V58a6 6 0 0 1 6-6z" ${TINT}/>`,
    `<circle cx="80" cy="70" r="6" ${absent(42)}/>`,
    `<path d="M80 78v10" ${absent()}/>`,
  ],

  /** One person, and the two who have not been added */
  groups: [
    `<circle cx="80" cy="44" r="12" ${TINT}/>`,
    `<path d="M101 96V82a14 14 0 0 0-14-14H73a14 14 0 0 0-14 14v14" ${TINT}/>`,
    `<circle cx="44" cy="57" r="8" ${absent(49)}/>`,
    `<path d="M32 96v-8a11 11 0 0 1 11-11h11" ${absent(36)}/>`,
    `<circle cx="116" cy="57" r="8" ${absent(49)}/>`,
    `<path d="M128 96v-8a11 11 0 0 0-11-11h-11" ${absent(36)}/>`,
  ],

  /** The page that would have been at this address, and the glass that looked */
  missing: [
    `<path d="M46 20h36l14 14v54a6 6 0 0 1-6 6H46a6 6 0 0 1-6-6V26a6 6 0 0 1 6-6z" ${absent(245)}/>`,
    `<path d="M50 48h18" ${absent(15)}/>`,
    `<circle cx="96" cy="72" r="17" ${TINT}/>`,
    '<path d="M108.5 84.5L122 98" stroke-width="3"/>',
  ],

  /** A page that is there and could not be built: torn across, the halves apart */
  broken: [
    '<path d="M50 22h40l14 14v22l-4 4-8-6-8 6-8-6-8 6-8-6-8 6-8-6V28a6 6 0 0 1 6-6z"' +
      ` ${TINT}/>`,
    '<path d="M90 22v8a6 6 0 0 0 6 6h8"/>',
    '<path d="M54 42h18"/>',
    '<path d="M47 66l8 6 8-6 8 6 8-6 8 6 8-6 8 6 4-4v31a6 6 0 0 1-6 6H53a6 6 0 0 1-6-6z"' +
      ` ${TINT}/>`,
    `<path d="M57 83h40M57 93h26" ${absent()}/>`,
  ],

  /** A search box with something typed in it, and the results that did not come */
  unmatched: [
    `<rect x="36" y="28" width="88" height="20" rx="10" ${TINT}/>`,
    '<circle cx="48" cy="37.5" r="3.5"/>',
    '<path d="M50.5 40l3 3"/>',
    '<path d="M62 38h30"/>',
    '<path d="M96 33v10" opacity="0.55"/>',
    `<path d="M44 66h72M44 78h58M44 90h40" ${absent()}/>`,
  ],
} as const satisfies Record<string, readonly string[]>;

/** Which drawing: `page` stands for anything, the rest for one thing each */
export type EmptyArt = keyof typeof DRAWINGS;

export const EMPTY_ART: readonly EmptyArt[] = Object.keys(DRAWINGS) as EmptyArt[];

/** Rendered on first use and kept: the markup is the same on every page */
const rendered = new Map<EmptyArt, string>();

/**
 * Inline SVG of an empty state
 *
 * Hidden from assistive technology: it is always drawn beside the sentence that
 * says what is missing
 */
export function emptyStateArt(kind: EmptyArt = 'page'): string {
  const cached = rendered.get(kind);
  if (cached !== undefined) return cached;

  const markup =
    `<svg class="spr-empty-art" viewBox="${VIEW_BOX}" fill="none" stroke="currentColor" ` +
    `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${GROUND}${DRAWINGS[kind].join('')}${FLOATING}</svg>`;
  rendered.set(kind, markup);
  return markup;
}

/** The configuration indexes with a drawing of their own, by section id */
export const SECTION_EMPTY_ART = [
  'identity',
  'sources',
  'admins',
  'groups',
] as const satisfies readonly EmptyArt[];

const MEMBER_EMPTY_ART: ReadonlyMap<string, EmptyArt> = new Map([['groups', 'groups']]);

export function sectionEmptyArt(sectionId: string): string {
  const [section, member, ...rest] = sectionId.split('/');
  const kind =
    member === undefined
      ? SECTION_EMPTY_ART.find((id) => id === section)
      : rest.length === 0 && member !== ''
        ? MEMBER_EMPTY_ART.get(section)
        : undefined;
  return kind === undefined ? '' : emptyStateArt(kind);
}
