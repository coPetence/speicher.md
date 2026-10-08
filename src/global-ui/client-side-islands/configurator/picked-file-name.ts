/** Shows the chosen file's name beside a stored file, since a file input cannot report its own value. */
import { configForm } from './config-form-handle';

export function mountPickedFileNames(): void {
  const form = configForm();
  if (!form) return;

  form.addEventListener('change', (event) => {
    const picker = event.target as HTMLInputElement;
    if (picker.type !== 'file') return;
    const named = picker.closest('.spr-stored')?.querySelector<HTMLElement>('[data-spr-picked]');
    if (!named) return;
    const chosen = picker.files?.[0]?.name ?? '';
    named.textContent = chosen;
    named.hidden = chosen === '';
  });
}
