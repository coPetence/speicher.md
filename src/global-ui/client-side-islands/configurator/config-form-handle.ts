/**
 * Shared references to the config form
 *
 * All mount functions call configForm and return early when the result is
 * null, so the islands are no-ops off the config page
 *
 * reportScriptedEdit fires a synthetic input event so the unsaved-changes-bar
 * notices programmatic edits
 */

const FORM_SELECTOR = 'form.spr-config[data-spr-config]';

/** Returns the config form, or null when not on a config page */
export function configForm(): HTMLFormElement | null {
  return document.querySelector<HTMLFormElement>(FORM_SELECTOR);
}

/** Notifies the unsaved-changes-bar that script changed a field value */
export function reportScriptedEdit(target: Element): void {
  target.dispatchEvent(new Event('input', { bubbles: true }));
}
