/**
 * Nav fold animation and persistence
 *
 * Mounts the slide animation and open-state cookie persistence for the nav
 * column's collapsible sections
 */

import { mountNav } from './slide';

/** Bootstraps nav fold animation and open-state persistence */
function mount(): void {
  mountNav();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
