/**
 * Enter in a config field leaves the field instead of saving the page
 *
 * JS enabled exclusive:
 *    Text-like inputs lose focus, Buttons and file inputs keep Enter
 *    Inputs in a modal are left alone, so Enter stays a no-op there
 */

import { configForm } from './config-form-handle';

const OWN_ENTER = new Set(['submit', 'button', 'reset', 'image', 'file']);
const NO_TEXT = new Set(['checkbox', 'radio']);

export function mountEnterLeavesField(): void {
  const form = configForm();
  if (!form) return;

  form.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented) return;

    const control = event.target;
    if (!(control instanceof HTMLInputElement) || OWN_ENTER.has(control.type)) return;
    if (control.closest('.spr-modal')) return;

    event.preventDefault();
    if (!NO_TEXT.has(control.type)) control.blur();
  });
}
