/** Config page types */

import type { CheckStatus } from '../../../common/check-status';
import type { CardItem, Field } from './config-fields';

export interface Option {
  value: string;
  label: string;
  // Live preview URL for template fields
  previewHref?: string;
  // Suggested identifier for a new member
  suggest?: string;
  // Brand mark identifier
  mark?: string;
  // Unavailability reason as help markup
  unavailable?: string;
}

export function unavailableOption(option: Option, reason: string): Option {
  return { ...option, unavailable: reason };
}

/** Field or row save error with a stable code and dashboard text */
export interface FormProblem {
  code: string;
  text: string;
}

/** A field's live check; see `CheckStatus` */
export type FieldStatus = CheckStatus;

export interface AddOp {
  op: string;
  label: string;
  // Name input label; null if unnamed
  nameLabel: string | null;
  // Help markup for the name input
  nameHelp?: string;
  // Name regex; null if no name input
  namePattern: string | null;
  // Name pattern description; null if no name input
  nameHint: string | null;
  nameOptions?: Option[];
  // Type selector label; null if no type choice
  typeLabel: string | null;
  typeOptions: Option[];
  // Opens a page instead of adding inline
  opensPage?: boolean;
  // Explicit URL overriding the op-derived URL
  href?: string;
  // Card index to insert the button before
  beforeCard?: number;
}

export interface EntryLine {
  label: string;
  value: string;
  // Provider mark identifier; see provider-marks.ts
  mark: string;
  // External lookup URL for the value
  href?: string;
  // Display in the failure colour
  failed?: boolean;
}

export interface SectionEntry {
  // Detail page URL; empty if none
  href: string;
  title: string;
  subtitle: string;
  // Render subtitle as help markup
  subtitleIsProse?: boolean;
  // Brand mark identifier; see provider-marks.ts
  mark: string;
  // Lucide icon name
  icon: string;
  badges: { label: string; icon: string }[];
  lines: EntryLine[];
  // Table column values
  cells: string[];
  // Lowercase search text
  search: string;
  // Fields submitted as hidden inputs
  carried: Field[];
  // Inline editing fields
  fields: Field[];
  // Removal operation; null if removal is forbidden
  removeOp: string | null;
  // Position in a list collection
  position: number;
  // Row type in mixed tables; see sourceKindAt
  kind?: string;
  // Last save errors for this row or its fields
  problems?: FormProblem[];
}

export interface TableColumn {
  label: string;
  // Help markup for the info marker
  help: string;
}

export function column(label: string, help = ''): TableColumn {
  return { label, help };
}

export interface TableAddKind {
  value: string;
  label: string;
  // Lucide icon name
  icon: string;
  // Help markup below the label
  help?: string;
  // Input label
  nameLabel: string;
  options: Option[];
  // Allow multiple selections
  multiple?: boolean;
  matches?: { label: string; placeholder: string; help: string };
}

/** Add-row modal selecting a row type and name in one operation */
export interface TableAdd {
  op: string;
  // Label for both add buttons
  label: string;
  // Modal title
  title: string;
  // Screen-reader label for the row types
  question: string;
  kinds: TableAddKind[];
}

export interface ValueTable {
  title: string;
  columns: TableColumn[];
  bulkRemoveOp: string;
  entries: SectionEntry[];
  // Empty-table message
  emptyNote: string;
  // Add-row control; absent if adding is forbidden
  add?: TableAdd;
}

export interface Card {
  title: string;
  // Render document-key titles in monospace
  titleIsKey?: boolean;
  // Mark the title with an asterisk
  required?: boolean;
  subtitle: string;
  removeOp: string | null;
  // Fields, copy values and choices in display order
  items: CardItem[];
  cards: Card[];
  addOps: AddOp[];
  notes: string[];
  // Switch path controlling visibility; hidden controls still submit
  shownWith?: string;
  // Radio option value that shows this card
  shownWhen?: string;
  enabledWith?: string;
  toggle?: string;
  hidden?: boolean;
}

export interface FormSection {
  // Header status indicator
  status?: FieldStatus;
  // Status check endpoint URL
  checkHref?: string;
  id: string;
  title: string;
  // Help markup at the section top
  blurb: string;
  fields: Field[];
  cards: Card[];
  addOps: AddOp[];
  // Parent section ID; null for top-level sections
  parent: string | null;
  // Brand mark identifier
  mark?: string;
  // Section or member removal operation
  removeOp?: string | null;
  // Section or member rename operation
  renameOp?: string | null;
  // Clear stored field values; null hides reset when none are stored
  resetOp?: string | null;
  // Regex for the new name
  renamePattern?: string;
  // Rename pattern description
  renameHint?: string;
  entries: SectionEntry[];
  // Entry layout
  layout?: 'tiles' | 'table';
  // Arrange fields in two equal full-width columns
  twoColumns?: boolean;
  // Arrange cards in a grid
  cardGrid?: boolean;
  // Entry tables
  tables?: ValueTable[];
  // Entry tiles link to detail pages
  entriesArePages?: boolean;
  // Table column labels
  columns?: string[];
  // Hide the lines column but keep its content searchable
  hideLines?: boolean;
  // Remove checked entries; checkboxes carry each entry's removeOp
  bulkRemoveOp?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  // Term for a section member
  noun?: string;
  // Term for an entry within a member
  entryNoun?: string;
}

export interface SectionIndexEntry {
  id: string;
  title: string;
  // Navigation icon identifier
  icon: string;
  // Parent section ID
  parent?: string;
  disabled?: boolean;
}

/** Collect all fields, including nested, carried and attached fields */
export function allFields(sections: FormSection[]): Field[] {
  const out: Field[] = [];
  // Include attached fields after their parent
  const push = (field: Field) => {
    out.push(field);
    field.attached.forEach(push);
  };
  for (const section of sections) {
    section.fields.forEach(push);
    fieldsOf(section.cards.flatMap(itemsOfCard)).forEach(push);
    // Include section and table entries
    for (const entry of allEntries(section)) {
      entry.fields.forEach(push);
      entry.carried.forEach(push);
    }
  }
  return out;
}

/** Collect card items, including nested cards and choice contents */
export function cardItems(sections: FormSection[]): CardItem[] {
  const out: CardItem[] = [];
  const push = (item: CardItem) => {
    out.push(item);
    if (item.kind !== 'choice') return;
    if (item.follows) push(item.follows);
    for (const option of item.options) option.items.forEach(push);
  };
  for (const section of sections) section.cards.flatMap(itemsOfCard).forEach(push);
  return out;
}

/** Extract fields, including choice follow-ups and option fields */
export function fieldsOf(items: CardItem[]): Field[] {
  return items.flatMap((item): Field[] => {
    if (
      item.kind === 'copy-value' ||
      item.kind === 'github-app-manifest' ||
      item.kind === 'github-app-links'
    ) {
      return [];
    }
    if (item.kind === 'choice') {
      const options = item.options.flatMap((option) => fieldsOf(option.items));
      return item.follows ? [item.follows, ...options] : options;
    }
    return [item];
  });
}

// Collect card items before nested card items
function itemsOfCard(card: Card): CardItem[] {
  return [...card.items, ...card.cards.flatMap(itemsOfCard)];
}

export function allEntries(section: FormSection): SectionEntry[] {
  return [...section.entries, ...(section.tables ?? []).flatMap((table) => table.entries)];
}

/** Collect all section, card and entry operations */
export function allOps(sections: FormSection[]): string[] {
  const out: string[] = [];
  const walk = (card: Card) => {
    if (card.removeOp) out.push(card.removeOp);
    out.push(...card.addOps.map((a) => a.op));
    card.cards.forEach(walk);
  };
  for (const section of sections) {
    out.push(...section.addOps.map((a) => a.op));
    for (const entry of allEntries(section)) if (entry.removeOp) out.push(entry.removeOp);
    for (const table of section.tables ?? []) {
      out.push(table.bulkRemoveOp);
      if (table.add) out.push(table.add.op);
    }
    if (section.bulkRemoveOp) out.push(section.bulkRemoveOp);

    if (section.removeOp) out.push(section.removeOp);
    if (section.renameOp) out.push(section.renameOp);
    if (section.resetOp) out.push(section.resetOp);
    section.cards.forEach(walk);
  }
  return out;
}
