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
import { mountNav } from './slide';
import { mountConfigBar } from './configurator/unsaved-changes-bar';
import { mountPickedFileNames } from './configurator/picked-file-name';
import { mountFileDrops } from './configurator/drop-in-field';
import { mountReshapeSubmits } from './configurator/reshape-submits-form';
import { mountEnterLeavesField } from './configurator/enter-leaves-field';
import { mountModals } from './configurator/modal-focus-and-escape';
import { mountDropdowns } from './configurator/picture-dropdown';
import { mountBlockedAnswers } from './configurator/unavailable-choice-blocker';
import { mountSuggestions } from './configurator/suggested-name-fill';
import { mountReveals } from './configurator/dependent-field-visibility';
import { mountChoices } from './configurator/choice-switch';
import { mountCopies } from './configurator/copy-from-sibling-field';
import { mountSecretMasks } from './configurator/secret-mask-replace';
import { mountOriginPaths } from './configurator/origin-before-path';
import { mountSwatches } from './configurator/colour-swatch-picker';
import { mountBulkRowRemoval } from './configurator/bulk-row-removal';
import { mountPickLists } from './configurator/pick-list';
import { mountChecks } from './configurator/live-connection-check';
import { mountWidths } from './configurator/embedding-width-lookup';
import { mountFragments } from './configurator/open-folded-on-fragment';
import { mountKnownHostsTables } from './configurator/known-hosts-table';
import { mountRepositoryIds } from './configurator/repository-id-from-url';
import { mountLanding } from './configurator/land-on-changed-entry';
import { mountPreviewFades } from './configurator/template-preview-fade';
import { mountOptionSearches } from './configurator/option-search';

function mount(): void {
  mountNav();
  mountConfigBar();

  mountPickedFileNames();
  mountFileDrops();
  mountReshapeSubmits();
  mountEnterLeavesField();
  mountChecks();

  mountFilter('.spr-entries');
  mountModals();
  mountDropdowns();
  mountBlockedAnswers();
  mountSuggestions();
  mountReveals();
  mountChoices();
  mountCopies();
  mountSecretMasks();
  mountOriginPaths();
  mountCopy();
  mountWidths();
  mountSwatches();
  mountBulkRowRemoval();
  mountPickLists();
  mountFragments();
  mountKnownHostsTables();
  mountRepositoryIds();
  mountLanding();
  mountPreviewFades();
  mountOptionSearches();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
