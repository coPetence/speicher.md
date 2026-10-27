/**
 * Copy from `data-spr-copy-from` on `data-spr-copy` clicks
 * Empty or masked sources are copied server-side on save
 */
import { SECRET_MASK } from '../../secret-mask';
import { configForm, reportScriptedEdit } from './config-form-handle';

export function mountCopies(): void {
  const form = configForm();
  if (!form) return;

  for (const button of form.querySelectorAll<HTMLButtonElement>('button[data-spr-copy]')) {
    const field = button.closest<HTMLElement>('[data-spr-copy-from]');
    if (!field) continue;

    // Show copy buttons when JS is available
    button.hidden = false;

    button.addEventListener('click', () => {
      const target = field.querySelector<HTMLInputElement>('input[name]');
      const source = form.querySelector<HTMLInputElement>(
        `input[name="${field.dataset.sprCopyFrom ?? ''}"]`,
      );
      if (!target) return;

      // Treat masked values as empty
      const shown = source?.value.trim() ?? '';
      const value = shown === SECRET_MASK ? '' : shown;
      if (value !== '') {
        target.value = value;
      } else {
        // Request a server-side copy on save
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
