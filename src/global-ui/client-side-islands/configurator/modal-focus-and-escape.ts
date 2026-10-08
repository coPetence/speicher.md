/**
 * Focus-on-open and close-on-Escape for `<details class="spr-modal">`
 *
 * Modals use the native `<details>` open/close behaviour; JS only adds
 * auto-focus and the Escape shortcut
 * Controls inside a closed nested details element are skipped to avoid
 * focusing an element in an unopened dropdown within the modal
 */

export function mountModals(): void {
  const modals = Array.from(document.querySelectorAll<HTMLDetailsElement>('details.spr-modal'));
  if (modals.length === 0) return;

  for (const modal of modals) {
    modal.addEventListener('toggle', () => {
      if (!modal.open) return;

      const controls = modal.querySelectorAll<HTMLElement>('input, select, textarea');
      for (const control of Array.from(controls)) {
        // Skips elements whose closest <details> ancestor is closed
        if (control.closest('details:not([open])')) continue;
        control.focus();
        return;
      }
    });
  }

  addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = modals.find((modal) => modal.open);
    if (!open) return;
    open.open = false;

    open.querySelector('summary')?.focus();
  });
}
