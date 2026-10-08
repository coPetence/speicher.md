/**
 * Config history version comparison island
 *
 * Mounts nav fold slide animations for the sidebar details
 * Auto-submits the compare form on select change, hiding the now-redundant submit button
 */

import { mountNavFolds } from './slide';

/** Selector for the version comparison form */
const COMPARE = 'form[data-spr-compare]';

/**
 * Hides submit buttons and submits the compare form on select change
 *
 * Not form.submit(): requestSubmit triggers validation and submit events
 */
function mountCompare(): void {
  mountNavFolds();
  const form = document.querySelector<HTMLFormElement>(COMPARE);
  if (!form) return;

  for (const button of form.querySelectorAll<HTMLButtonElement>('button[type="submit"]')) {
    button.hidden = true;
  }
  form.addEventListener('change', (event) => {
    if (!(event.target instanceof HTMLSelectElement)) return;
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountCompare, { once: true });
} else {
  mountCompare();
}
