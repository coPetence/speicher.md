/**
 * Changes to a note the `@note` component drew, after the page has loaded
 */

import { noteIconHref } from '../note';

/** Sets the level of a note: its `spr-note-*` class and the icon it draws */
export function setNoteLevel(note: HTMLElement, level: string): void {
  for (const name of [...note.classList]) {
    if (name.startsWith('spr-note-')) note.classList.remove(name);
  }
  note.classList.add(`spr-note-${level}`);
  note.querySelector(':scope > .spr-icon use')?.setAttribute('href', noteIconHref(level));
}

/** Replaces the text of a note and keeps its icon */
export function setNoteText(note: HTMLElement, text: string): void {
  const icon = note.querySelector(':scope > .spr-icon');
  note.replaceChildren(...(icon ? [icon] : []), text);
}
