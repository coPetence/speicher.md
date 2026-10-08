/**
 * CSS class names for MDX components
 *
 * Each component in components.ts outputs HTML with one of these class names
 * MDX_ALLOWED_CLASSES maps output elements to their permitted classes for the sanitizer
 * The sanitizer in markdown.ts merges this into its allowedClasses config
 */

/** CSS class for the tabs container div */
export const TABS_CLASS = 'spr-tabs';

/** CSS class for an individual tab panel div */
export const TAB_CLASS = 'spr-tab';

/** CSS class for the tab label paragraph */
export const TAB_LABEL_CLASS = 'spr-tab-label';

/** CSS class for the procedure/steps container div */
export const STEPS_CLASS = 'spr-procedure';

/** CSS class for the file tree container div */
export const FILE_TREE_CLASS = 'spr-file-tree';

/** CSS class for a listing container (card grids, card rows) */
export const LISTING_CLASS = 'spr-listing';

/** CSS class for a multi-column card grid */
export const CARDS_CLASS = 'spr-cards';

/** CSS class for a single-row card list */
export const CARDS_ROWS_CLASS = 'spr-cards-rows';

/** CSS class for a card list item */
export const CARD_CLASS = 'spr-card';

/** CSS class for a card title paragraph */
export const CARD_TITLE_CLASS = 'spr-card-title';

/** CSS class for a chip/badge inline element */
export const CHIP_CLASS = 'spr-chip';

/** CSS class for a link styled as a button */
export const LINK_BUTTON_CLASS = 'spr-link-button';

/** HTML attribute for syncing open tabs across pages by a key */
export const TABS_SYNC_ATTR = 'data-spr-tabs';

/** Values that produce spr-chip-{variant} modifier classes */
export const CHIP_VARIANTS = new Set(['note', 'tip', 'caution', 'danger', 'success']);

/** HTML elements and the classes the sanitizer allows on them
 *
 * The sanitizer in markdown.ts strips classes not listed here
 * Each component outputs its class on the element mapped here
 * The span glob permits chip variant modifier classes */
export const MDX_ALLOWED_CLASSES = {
  div: [TABS_CLASS, TAB_CLASS, STEPS_CLASS, FILE_TREE_CLASS],
  ul: [LISTING_CLASS, CARDS_CLASS, CARDS_ROWS_CLASS],
  li: [CARD_CLASS],
  p: [TAB_LABEL_CLASS, CARD_TITLE_CLASS],
  span: [CHIP_CLASS, `${CHIP_CLASS}-*`],
  a: [LINK_BUTTON_CLASS],
} as const;
