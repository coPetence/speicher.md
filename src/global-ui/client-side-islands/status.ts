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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
