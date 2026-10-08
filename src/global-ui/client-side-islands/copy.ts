/**
 * Copy-to-clipboard buttons as a progressive enhancement
 *
 * Buttons with `data-spr-copy` are hidden by default and shown when the Clipboard API is available
 * Clicking writes the attribute value to the clipboard and sets `data-spr-state` on the button
 * A shared `data-spr-copy-status` element announces the result to screen readers
 * On failure the status becomes visible so the user can read the manual instruction
 *
 * The state resets after a delay
 */

/** Duration to show the "copied" state: long enough for screen reader announcement */
const COPIED_MS = 2_000;

/** Duration to show failure: gives the user time to read the manual instruction */
const FAILED_MS = 8_000;

/** Reveals copy buttons and wires clipboard copy on click */
export function mountCopy(): void {
  if (!navigator.clipboard) return;

  const buttons = document.querySelectorAll<HTMLButtonElement>('[data-spr-copy]');
  const status = document.querySelector<HTMLElement>('[data-spr-copy-status]');
  let reset = 0;

  // Sets state on button and status, queues a reset of all buttons
  // Resets every button, not just this one: a second click restarts the timer cleanly
  const show = (button: HTMLButtonElement, copied: boolean): void => {
    const state = copied ? 'copied' : 'failed';
    button.dataset.sprState = state;
    if (status) {
      status.dataset.sprState = state;
      status.textContent = copied
        ? 'Copied.'
        : 'Failed to copy. Please select the text and copy it manually.';
    }

    window.clearTimeout(reset);
    reset = window.setTimeout(
      () => {
        for (const button of buttons) delete button.dataset.sprState;
        if (status) {
          delete status.dataset.sprState;
          status.textContent = '';
        }
      },
      copied ? COPIED_MS : FAILED_MS,
    );
  };

  for (const button of buttons) {
    button.hidden = false;
    button.addEventListener('click', () => {
      void navigator.clipboard.writeText(button.dataset.sprCopy ?? '').then(
        () => show(button, true),
        () => show(button, false),
      );
    });
  }
}
