/**
 * Puts the page's own origin in front of a path offered to copy
 */
import { configForm } from './config-form-handle';

export function mountOriginPaths(): void {
  const form = configForm();
  if (!form) return;

  for (const copyable of form.querySelectorAll<HTMLElement>('[data-spr-origin-path]')) {
    const shown = copyable.querySelector('code');
    const button = copyable.querySelector<HTMLButtonElement>('[data-spr-clipboard]');
    if (!shown) continue;
    const url = `${location.origin}${shown.textContent ?? ''}`;
    shown.textContent = url;
    if (button) button.dataset.sprClipboard = url;

    const field = copyable.closest('.spr-field');
    const forPath = field?.querySelector<HTMLElement>('[data-spr-path-fact]');
    const forUrl = field?.querySelector<HTMLElement>('[data-spr-origin-fact]');
    if (forPath) forPath.hidden = true;
    if (forUrl) forUrl.hidden = false;
  }
}
