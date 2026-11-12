/**
 * Nav fold animation and persistence
 *
 * Mounts the slide animation and open-state cookie persistence for the nav
 * column's collapsible sections
 */

import { mountHistorySteps } from './history-steps';
import { mountNav } from './slide';

/** Bootstraps nav fold animation and open-state persistence, and the back and forward buttons of the crumbs */
function mount(): void {
  mountNav();
  mountHistorySteps();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
