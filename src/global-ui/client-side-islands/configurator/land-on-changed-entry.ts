/**
 * Focuses the first field of the entry that Add just created, and removes
 * `#spr-landing` from the address
 *
 * The config form posts to `#spr-landing`. After Add, Remove or Fetch host keys, the
 * server puts `id="spr-landing"` on the card the page opens at, so the browser scrolls
 * there before it draws the page. The fragment is removed so that a later reload
 * opens the page at the top.
 */
import { configForm } from './config-form-handle';

const LANDING = 'spr-landing';

export function mountLanding(): void {
  const form = configForm();
  if (!form || location.hash !== `#${LANDING}`) return;
  history.replaceState(history.state, '', location.pathname + location.search);

  if (!form.hasAttribute('data-spr-landing-focus')) return;
  document
    .getElementById(LANDING)
    ?.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select')
    ?.focus({ preventScroll: true });
}
