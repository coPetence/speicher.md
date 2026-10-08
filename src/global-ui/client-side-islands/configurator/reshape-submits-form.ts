/**
 * Auto-submit the config form when a reshapes trigger changes
 *
 * A field with `data-spr-reshapes` is one whose value decides which other fields
 * appear -- switching the storage driver from filesystem to Azure replaces the
 * path field with Azure auth fields.  The server receives the submission and
 * re-renders the form with the right fields
 *
 * Uses `change`, not `input`, because the trigger is always a <select> --
 * committed pick, not keystroke
 */

import { configForm } from './config-form-handle';

export function mountReshapeSubmits(): void {
  const form = configForm();
  if (!form) return;

  form.addEventListener('change', (event) => {
    const control = event.target as HTMLElement;
    if (!control?.hasAttribute?.('data-spr-reshapes')) return;
    form.requestSubmit();
  });
}
