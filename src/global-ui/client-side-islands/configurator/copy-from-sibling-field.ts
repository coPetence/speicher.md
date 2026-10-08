/**
 * Copy values from one config field into another on click
 *
 * Fields with `data-spr-copy-from` identify a source field elsewhere in the
 * form
 * Buttons with `data-spr-copy` copy the source value on click
 *
 * When the source has no value on the page, the value is stored server-side and
 * the handler checks the stored-value checkbox to let the server copy it on
 * save
 */
import { configForm, reportScriptedEdit } from './config-form-handle';

export function mountCopies(): void {
  /** Mount copy buttons on the config form */
  const form = configForm();
  if (!form) return;

  for (const button of form.querySelectorAll<HTMLButtonElement>('button[data-spr-copy]')) {
    const field = button.closest<HTMLElement>('[data-spr-copy-from]');
    if (!field) continue;

    // Hidden without JS
    button.hidden = false;

    button.addEventListener('click', () => {
      const target = field.querySelector<HTMLInputElement>('input[name]');
      const source = form.querySelector<HTMLInputElement>(
        `input[name="${field.dataset.sprCopyFrom ?? ''}"]`,
      );
      if (!target) return;

      const value = source?.value.trim() ?? '';
      if (value !== '') {
        target.value = value;
      } else {
        // Source empty means the value is stored server-side; mark for server copy on save
        const stored = field.querySelector<HTMLInputElement>('[data-spr-copy-stored]');
        if (!stored) return;
        stored.checked = true;
      }

      const note = field.querySelector<HTMLElement>('[data-spr-copy-note]');
      if (note && value === '') note.hidden = false;
      reportScriptedEdit(form);
    });
  }
}
