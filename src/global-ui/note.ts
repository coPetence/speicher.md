export interface Note {
  /** ok, warn, fail or idle. A note without a level is an info note. */
  level?: string;
  text?: string;
  html?: string;
  /** tag is the element of the note. A note with block content needs a `div`. */
  tag?: 'p' | 'div';
}

const NOTE_ICONS: Record<string, string> = {
  ok: 'circle-check',
  warn: 'triangle-alert',
  fail: 'circle-x',
};

const DEFAULT_NOTE_ICON = 'info';

export const NOTE_ICON_NAMES = [...Object.values(NOTE_ICONS), DEFAULT_NOTE_ICON];

/**
 * noteIconName returns the name of the icon for a note level. It returns `info` for any other level.
 * @param level the level of the note
 */
export function noteIconName(level: string | undefined): string {
  return NOTE_ICONS[level ?? ''] ?? DEFAULT_NOTE_ICON;
}

/**
 * noteIconHref returns the reference to the icon for a note level in the page sprite.
 * @param level the level of the note
 */
export function noteIconHref(level: string | undefined): string {
  // The prefix must match SYMBOL_PREFIX in icons.ts
  return `#i-${noteIconName(level)}`;
}
