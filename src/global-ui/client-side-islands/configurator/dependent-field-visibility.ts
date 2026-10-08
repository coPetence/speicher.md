/**
 * Conditional visibility of config fields that depend on another field's value
 *
 * Fields with `data-spr-shown-with` are shown only when the named controlling
 * field has a non-empty value (select) or is checked (checkbox)
 * Runs on mount and on every change of the controlling field
 *
 * Not disabled: submitted values are unaffected by visibility
 */

import { configForm } from './config-form-handle';

export function mountReveals(): void {
  const form = configForm();
  if (!form) return;

  // Distinct controlling field names declared across the form
  const groups = new Set(
    [...form.querySelectorAll<HTMLElement>('[data-spr-shown-with]')].map(
      (field) => field.dataset.sprShownWith ?? '',
    ),
  );

  for (const group of groups) {
    if (group === '') continue;

    const master = form.querySelector<HTMLSelectElement | HTMLInputElement>(
      `select[name="${group}"], input[type="checkbox"][name="${group}"]`,
    );
    if (!master) continue;

    const belonging = [...form.querySelectorAll<HTMLElement>(`[data-spr-shown-with="${group}"]`)];

    // Checkbox: hidden when unchecked. Select: hidden when no option chosen
    const settle = () => {
      const asked = master instanceof HTMLInputElement ? master.checked : master.value !== '';
      for (const element of belonging) element.hidden = !asked;
    };

    settle();

    master.addEventListener('change', settle);
  }
}
