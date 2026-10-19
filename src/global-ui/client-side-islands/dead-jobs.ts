/**
 * Client-side island for the dead jobs page
 *
 * Shows the header checkbox that ticks every job on the page, and keeps it in
 * step with the rows
 */

import { mountNavFolds } from './slide';

function mountSelectPage(): void {
  const form = document.querySelector<HTMLFormElement>('[data-spr-dead-jobs]');
  const all = form?.querySelector<HTMLInputElement>('[data-spr-select-page]');
  if (!form || !all) return;

  const rows = Array.from(form.querySelectorAll<HTMLInputElement>('tbody input[name="ids"]'));
  const sync = (): void => {
    const ticked = rows.filter((box) => box.checked).length;
    all.checked = ticked === rows.length;
    all.indeterminate = ticked > 0 && ticked < rows.length;
  };

  all.hidden = false;
  all.addEventListener('change', () => {
    for (const box of rows) box.checked = all.checked;
    sync();
  });
  for (const box of rows) box.addEventListener('change', sync);

  // A browser can restore ticked rows on back navigation
  sync();
}

function mount(): void {
  mountNavFolds();
  mountSelectPage();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
