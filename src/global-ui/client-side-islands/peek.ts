/**
 * Shows previews instantly while Ctrl or Cmd is held
 *
 * Sets `data-spr-peek` on the root element while the user holds the modifier key
 * The CSS overrides the normal hover delay so previews appear without waiting
 * Clears the attribute on release, blur, or tab hide
 */

const PEEK_ATTRIBUTE = 'data-spr-peek';

/** Sets up event listeners that toggle the attribute on modifier key state */
export function mountPeek(): void {
  const root = document.documentElement;

  const set = (held: boolean): void => {
    if (held) root.setAttribute(PEEK_ATTRIBUTE, '');
    else root.removeAttribute(PEEK_ATTRIBUTE);
  };

  const fromEvent = (event: KeyboardEvent): void => set(event.ctrlKey || event.metaKey);

  addEventListener('keydown', fromEvent);
  addEventListener('keyup', fromEvent);

  addEventListener('blur', () => set(false));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) set(false);
  });
}
