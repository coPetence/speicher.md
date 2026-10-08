/**
 * Entry for cover-image failure cleanup
 *
 * Triggers mountCovers when the document is ready for interaction
 * The readyState check lets the bundle run regardless of whether
 * DOMContentLoaded has already fired
 */
import { mountCovers } from './cover-tile';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountCovers(), { once: true });
} else {
  mountCovers();
}
