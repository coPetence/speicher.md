/**
 * Mount all client-side islands
 *
 * Each import attaches JavaScript behaviour to a piece of server-rendered HTML
 * The groups below separate global navigation, form behaviours and interactive UI
 *
 * The outer block ensures mount runs once the DOM is ready, whether the script
 * is loaded before or after DOMContentLoaded
 */

import { mountCopy } from './copy';
import { mountFilter } from './filter';
import { mountNavFolds } from './slide';
import { mountConfigBar } from './configurator/unsaved-changes-bar';
import { mountPickedFileNames } from './configurator/picked-file-name';
import { mountFileDrops } from './configurator/drop-in-field';
import { mountReshapeSubmits } from './configurator/reshape-submits-form';
import { mountModals } from './configurator/modal-focus-and-escape';
import { mountDropdowns } from './configurator/picture-dropdown';
import { mountBlockedAnswers } from './configurator/unavailable-choice-blocker';
import { mountSuggestions } from './configurator/suggested-name-fill';
import { mountReveals } from './configurator/dependent-field-visibility';
import { mountCopies } from './configurator/copy-from-sibling-field';
import { mountOriginPaths } from './configurator/origin-before-path';
import { mountSwatches } from './configurator/colour-swatch-picker';
import { mountGrowingTables } from './configurator/growing-source-tables';
import { mountChecks } from './configurator/live-connection-check';
import { mountWidths } from './configurator/embedding-width-lookup';
import { mountFragments } from './configurator/open-folded-on-fragment';

function mount(): void {
  mountNavFolds();
  mountConfigBar();

  mountPickedFileNames();
  mountFileDrops();
  mountReshapeSubmits();
  mountChecks();

  mountFilter('.spr-entries');
  mountModals();
  mountDropdowns();
  mountBlockedAnswers();
  mountSuggestions();
  mountReveals();
  mountCopies();
  mountOriginPaths();
  mountCopy();
  mountWidths();
  mountSwatches();
  mountGrowingTables();
  mountFragments();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
