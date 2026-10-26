/**
 * Focus-on-open and close-on-Escape for `<details class="spr-modal">`
 *
 * Modals use the native `<details>` open/close behaviour; JS only adds
 * auto-focus and the Escape shortcut
 * Controls inside a closed nested details element are skipped to avoid
 * focusing an element in an unopened dropdown within the modal
 */

export function mountModals(): void {
  mountToggledModals();
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

  // A Cancel button inside a modal closes it the way Escape does
  addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const cancel = event.target.closest('[data-spr-modal-cancel]');
    const modal = cancel?.closest<HTMLDetailsElement>('details.spr-modal');
    if (!cancel || !modal) return;
    modal.open = false;
    modal.querySelector('summary')?.focus();
  });
}

function mountToggledModals(): void {
  const toggles = Array.from(
    document.querySelectorAll<HTMLInputElement>('input.spr-row-edit-toggle'),
  );
  if (toggles.length === 0) return;

  const dialogOf = (toggle: HTMLInputElement): HTMLElement | null =>
    toggle.parentElement?.querySelector<HTMLElement>('.spr-row-edit-dialog') ?? null;

  for (const toggle of toggles) {
    toggle.addEventListener('change', () => {
      if (!toggle.checked) return;
      dialogOf(toggle)
        ?.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea')
        ?.focus();
    });
  }

  addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = toggles.find((toggle) => toggle.checked);
    if (!open) return;
    open.checked = false;
    open.parentElement?.querySelector<HTMLElement>(`label[for="${open.id}"]`)?.focus();
  });

  // Save keeps the dialog open over a field the browser would refuse, and says why
  addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const done = event.target.closest('.spr-row-edit-done');
    const dialog = done?.closest<HTMLElement>('.spr-row-edit-dialog');
    if (!done || !dialog) return;
    const invalid = invalidControlIn(dialog);
    if (!invalid) return;
    event.preventDefault();
    invalid.reportValidity();
  });

  addEventListener(
    'invalid',
    (event) => {
      if (!(event.target instanceof Element)) return;
      const dialog = event.target.closest('.spr-row-edit-dialog');
      const toggle = toggles.find((each) => dialogOf(each) === dialog);
      if (toggle && !toggle.checked && !toggles.some((each) => each.checked)) {
        toggle.checked = true;
      }
    },
    true,
  );
}

function invalidControlIn(
  root: HTMLElement,
): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
  const controls = root.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >('input, select, textarea');
  return Array.from(controls).find((control) => !control.checkValidity()) ?? null;
}
