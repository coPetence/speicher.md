/**
 * Conditional visibility of config fields that depend on another field's value
 *
 * Fields with `data-spr-shown-with` are shown only when the named controlling
 * field has a non-empty value (select) or is checked (checkbox). When the
 * controlling field is the radio group of a choice, they are shown only while an
 * option named by `data-spr-shown-when` is checked; it may name several, separated
 * by spaces
 * Elements with `data-spr-enabled-with` stay visible but are made inert while the
 * controlling checkbox is unchecked
 * Runs on mount and on every change of the controlling field
 * Works in the config form and in each `data-spr-reveal-root` outside it, such as
 * the add modal, whose fields belong to their own form
 *
 * Not disabled: submitted values are unaffected by visibility
 */

import { configForm } from './config-form-handle';

export function mountReveals(): void {
  const form = configForm();
  const roots = [
    ...(form ? [form] : []),
    ...[...document.querySelectorAll<HTMLElement>('[data-spr-reveal-root]')].filter(
      (root) => !form?.contains(root),
    ),
  ];
  for (const root of roots) revealWithin(root);
}

function revealWithin(form: HTMLElement): void {
  // Distinct controlling field names declared across the root
  const groups = new Set(
    [...form.querySelectorAll<HTMLElement>('[data-spr-shown-with], [data-spr-enabled-with]')].map(
      (field) => field.dataset.sprShownWith ?? field.dataset.sprEnabledWith ?? '',
    ),
  );

  for (const group of groups) {
    if (group === '') continue;

    const belonging = [...form.querySelectorAll<HTMLElement>(`[data-spr-shown-with="${group}"]`)];
    const enabling = [...form.querySelectorAll<HTMLElement>(`[data-spr-enabled-with="${group}"]`)];

    const radios = [
      ...form.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${group}"]`),
    ];
    if (radios.length > 0) {
      const settleRadios = () => {
        const checked = radios.find((radio) => radio.checked)?.value;
        // `data-spr-shown-when` may name several options, separated by spaces
        for (const element of belonging) {
          const when = (element.dataset.sprShownWhen ?? '').split(/\s+/);
          element.hidden = checked === undefined || !when.includes(checked);
        }
      };
      settleRadios();
      for (const radio of radios) radio.addEventListener('change', settleRadios);
      continue;
    }

    const master = form.querySelector<HTMLSelectElement | HTMLInputElement>(
      `select[name="${group}"], input[type="checkbox"][name="${group}"]`,
    );
    if (!master) continue;

    // Checkbox: hidden when unchecked. Select: hidden when no option chosen
    const settle = () => {
      const asked = master instanceof HTMLInputElement ? master.checked : master.value !== '';
      for (const element of belonging) element.hidden = !asked;
      for (const element of enabling) element.toggleAttribute('inert', !asked);
    };

    settle();

    master.addEventListener('change', settle);
  }
}
