/**
 * Nav fold animation and persistence
 *
 * Mounts the slide animation and open-state cookie persistence for the nav
 * column's collapsible sections
 */

import { mountNavFolds } from './slide';

/** Bootstraps nav fold animation and open-state persistence */
function mount(): void {
  mountNavFolds();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
