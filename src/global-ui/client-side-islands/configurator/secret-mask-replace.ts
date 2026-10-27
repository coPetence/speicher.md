/**
 * Replace the secret mask on first input; clear it on deletion
 * Apply edits manually and notify the form so the save bar updates
 */

import { SECRET_MASK } from '../../secret-mask';
import { configForm, reportScriptedEdit } from './config-form-handle';

export function mountSecretMasks(): void {
  const form = configForm();
  if (!form) return;

  form.addEventListener('beforeinput', (event) => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement) || control.type !== 'password') return;
    if (control.value !== SECRET_MASK) return;

    const inserts = event.inputType.startsWith('insert');
    if (!inserts && !event.inputType.startsWith('delete')) return;

    // Clear the mask before an uncancelable edit
    if (!event.cancelable) {
      control.value = '';
      return;
    }

    event.preventDefault();
    control.value = inserts ? (event.data ?? event.dataTransfer?.getData('text/plain') ?? '') : '';
    reportScriptedEdit(control);
  });
}
