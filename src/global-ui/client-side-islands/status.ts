/**
 * Client-side island for the sync-status page
 *
 * Mounts the nav fold slide animation and cookie persistence, then the live
 * filter on the status table
 *
 * The table selector isolates the status table from other `.spr-table` elements
 * on the page (the configurator uses `.spr-table.spr-entries` and
 * `.spr-table.spr-rows`)
 *
 * No exports — runs as a side-effect when loaded as an ESM module
 */

import { mountFilter } from './filter';
import { mountNavFolds } from './slide';

// Selects the status table specifically; other tables with class `.spr-table`
// do not carry `data-spr-rows`
const TABLE = '.spr-table[data-spr-rows]';

function mount(): void {
  // Nav fold animation and open-state cookie; status page has a side nav
  mountNavFolds();
  // Live text filter on the repository table
  mountFilter(TABLE);
  mountStateMenu();
}

function mountStateMenu(): void {
  const menu = document.querySelector<HTMLDetailsElement>('form[data-spr-filter] .spr-filter-menu');
  const form = menu?.closest('form');
  if (!menu || !form) return;

  let changed = false;
  menu.addEventListener('change', () => {
    changed = true;
  });
  menu.addEventListener('toggle', () => {
    if (!menu.open && changed) form.requestSubmit();
  });

  addEventListener('click', (event) => {
    if (menu.open && event.target instanceof Node && !menu.contains(event.target)) {
      menu.open = false;
    }
  });
  addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    menu.querySelector('summary')?.focus();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
