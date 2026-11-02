import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Which drawing: `page` stands for anything, the rest for one thing each */
export const EMPTY_ART = [
  'page',
  'sources',
  'admins',
  'identity',
  'groups',
  'missing',
  'broken',
  'mail',
  'unmatched',
  'filtered',
] as const;

export type EmptyArt = (typeof EMPTY_ART)[number];

const ART_DIR = join(__dirname, 'empty-art');

function inline(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+xmlns="[^"]*"/, '')
    .replace(/<svg\b/, '<svg class="spr-empty-art"')
    .replace(/<svg\b([^>]*)>/, '<svg$1 aria-hidden="true">')
    .replace(/>\s+</g, '><')
    .trim();
}

/** Loaded once at startup */
const ART: Record<EmptyArt, string> = Object.fromEntries(
  EMPTY_ART.map((kind) => [kind, inline(readFileSync(join(ART_DIR, `${kind}.svg`), 'utf8'))]),
) as Record<EmptyArt, string>;

/**
 * Inline SVG of an empty state
 *
 * Hidden from assistive technology: it is always drawn beside the sentence that
 * says what is missing, and a picture announced ahead of that sentence is the
 * same thing said twice, the second time less precisely
 */
export function emptyStateArt(kind: EmptyArt = 'page'): string {
  return ART[kind];
}

/** The configuration indexes with a drawing of their own, by section id */
export const SECTION_EMPTY_ART = [
  'identity',
  'sources',
  'admins',
  'groups',
] as const satisfies readonly EmptyArt[];

/**
 * The drawing a configuration index has; the empty string for none
 *
 * Keyed on the id the route already holds, so a section gets its drawing with no
 * field added to the form's model — that model is what the JSON representation
 * serialises, and markup is not an answer a JSON caller asked for. An id with no
 * drawing keeps the plain note it had
 */
export function sectionEmptyArt(sectionId: string): string {
  const kind = SECTION_EMPTY_ART.find((id) => id === sectionId);
  return kind === undefined ? '' : emptyStateArt(kind);
}

export function tableEmptyArt(sectionId: string): string {
  return sectionId.startsWith('groups/') ? emptyStateArt('groups') : '';
}
