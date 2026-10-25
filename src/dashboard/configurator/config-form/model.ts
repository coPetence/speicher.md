/**
 * model.ts defines the types of a config page
 */

import type { CardItem, Field } from './config-fields';

export interface Option {
  value: string;
  label: string;
  // URL to a live preview (used for if FieldKind = template to render theme preview)
  previewHref?: string;
  // Suggested value for new-member creation (e.g. when creating Entra ID idp it can suggest a short id like entra-1)
  suggest?: string;
  // Brand mark identifier shown alongside the option (e.g. Entra ID Icon)
  mark?: string;
  // Why the option is unavailable, as help markup
  unavailable?: string;
}

export function unavailableOption(option: Option, reason: string): Option {
  return { ...option, unavailable: reason };
}

export interface FieldStatus {
  // Decides the note's colour and icon, see note.css
  level: 'info' | 'ok' | 'warn' | 'fail';
  label: string;
  detail: string;
}

export interface AddOp {
  op: string;
  label: string;
  // Label for the name input; null when the item has no name
  nameLabel: string | null;
  // Help markup beside the name label; absent when the name needs no explaining
  nameHelp?: string;
  // Regex pattern for the name; null when there is no name input
  namePattern: string | null;
  // namePattern in words; null when there is no name input
  nameHint: string | null;
  nameOptions?: Option[];
  // Label for the type selector; null when there is no type choice
  typeLabel: string | null;
  typeOptions: Option[];
  // Whether this navigates to a new page rather than inserting inline
  opensPage?: boolean;
  // Direct URL instead of computing one from the op
  href?: string;
  // Index of the section's card the button is drawn before, so that it can follow
  // the entries it adds to rather than the last card
  beforeCard?: number;
}

export interface EntryLine {
  label: string;
  value: string;
  // Provider mark identifier shown alongside the line (see `provider-marks.ts`)
  mark: string;
  // Where the value can be looked up outside, e.g. a directory group in its portal
  href?: string;
  // Drawn in the failure colour, e.g. an expiry that has passed
  failed?: boolean;
}

export interface SectionEntry {
  // URL to the entry's detail page; empty when there is no separate page
  href: string;
  title: string;
  subtitle: string;
  // True where the subtitle is prose to render as help markup.
  subtitleIsProse?: boolean;
  // Brand mark identifier shown alongside the entry (see `provider-marks.ts`)
  mark: string;
  // Lucide icon name for the entry tile
  icon: string;
  badges: { label: string; icon: string }[];
  lines: EntryLine[];
  // Cell values for table-format columns (e.g. "Added by")
  cells: string[];
  // Lowercased searchable text
  search: string;
  // Fields a row submits without showing (rendered as hidden inputs)
  carried: Field[];
  // Fields for inline editing
  fields: Field[];
  // Operation string to remove this entry; null when removal is not allowed
  removeOp: string | null;
  // Position in a list-based collection
  position: number;
  // The shape of this row where a table mixes them, e.g. `person`; see
  // `sourceKindAt`
  kind?: string;
}

export interface TableColumn {
  label: string;
  // Help markup behind the column's info marker
  help: string;
}

export function column(label: string, help = ''): TableColumn {
  return { label, help };
}

/** One shape of row a table's Add modal offers, with what that shape is drawn through */
export interface TableAddKind {
  value: string;
  label: string;
  // Lucide icon name drawn in front of the label
  icon: string;
  // Help markup under the label
  help?: string;
  // Label of the control that names what the row is drawn through
  nameLabel: string;
  options: Option[];
  // True where several of the options may be picked at once, each becoming a
  // row: drawn as a searchable list of boxes rather than a select
  multiple?: boolean;
  // The text area under the select, one match per line, where the kind takes
  // one: a row is added per line, and one empty row when nothing was typed.
  // Absent where the select is the whole match, e.g. a reference to a group
  matches?: { label: string; placeholder: string; help: string };
}

/** A table's Add control: a modal picking a kind of row and its name, submitted as one op */
export interface TableAdd {
  op: string;
  // The button, and the modal's own button
  label: string;
  // The modal's title, which may name what the rows are added to
  title: string;
  // What the list of kinds is called, for assistive technology; it is not drawn
  question: string;
  kinds: TableAddKind[];
}

export interface ValueTable {
  title: string;
  columns: TableColumn[];
  bulkRemoveOp: string;
  entries: SectionEntry[];
  // Text shown when the table is empty
  emptyNote: string;
  // The control that adds a row; absent where nothing can be added
  add?: TableAdd;
}

export interface Card {
  title: string;
  // True when the title is a key from the document, e.g. a repository id; it is
  // then drawn in a monospace font
  titleIsKey?: boolean;
  // Marks the title with an asterisk
  required?: boolean;
  subtitle: string;
  removeOp: string | null;
  // The card's fields, copy values and choices, drawn in order
  items: CardItem[];
  cards: Card[];
  addOps: AddOp[];
  notes: string[];
  // Path of a switch on the page; the card is hidden while it is off, and the
  // controls inside still submit their values
  shownWith?: string;
  // The option of a choice's radio group the card is shown with, e.g. `manual`
  shownWhen?: string;
  hidden?: boolean;
}

export interface FormSection {
  // Status indicator at the section header
  status?: FieldStatus;
  // URL to a status check endpoint
  checkHref?: string;
  id: string;
  title: string;
  // Help markup shown at the top of the section
  blurb: string;
  fields: Field[];
  cards: Card[];
  addOps: AddOp[];
  // Id of the parent section; null for top-level sections
  parent: string | null;
  // Brand mark identifier shown alongside the section
  mark?: string;
  // Operation string to remove the section or member
  removeOp?: string | null;
  // Operation string to rename the section or member
  renameOp?: string | null;
  // Operation string that removes the stored values of this page's fields from the
  // document; null when none is stored, so no reset button is drawn
  resetOp?: string | null;
  // Regex pattern the new name must match
  renamePattern?: string;
  // renamePattern in words
  renameHint?: string;
  entries: SectionEntry[];
  // Layout style for entries
  layout?: 'tiles' | 'table';
  // Tables of entries within a section
  tables?: ValueTable[];
  // Whether each entry tile navigates to its own page
  entriesArePages?: boolean;
  // Column labels for table-layout sections
  columns?: string[];
  // True where a table-layout section draws no column for its entries' lines;
  // the lines still feed the filter, so a row is found by what it is made of
  hideLines?: boolean;
  // The operation that removes every entry whose box is ticked, where an index
  // offers one; each entry's own `removeOp` is what the boxes carry
  bulkRemoveOp?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  // Name for a member in this section
  noun?: string;
  // Name for an entry within a member
  entryNoun?: string;
}

export interface SectionIndexEntry {
  id: string;
  title: string;
  // Icon identifier for navigation
  icon: string;
  // Id of the parent section for subsections
  parent?: string;
  disabled?: boolean;
}

/**
 * Collect every field across all sections, cards, entries and carried fields
 */
export function allFields(sections: FormSection[]): Field[] {
  const out: Field[] = [];
  // Attached fields pushed alongside their parent
  const push = (field: Field) => {
    out.push(field);
    field.attached.forEach(push);
  };
  for (const section of sections) {
    section.fields.forEach(push);
    fieldsOf(section.cards.flatMap(itemsOfCard)).forEach(push);
    // Both top-level entries and table entries
    for (const entry of allEntries(section)) {
      entry.fields.forEach(push);
      entry.carried.forEach(push);
    }
  }
  return out;
}

/**
 * Every item on the sections' cards and their nested cards, including the items
 * inside a choice's options
 */
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

/** The fields among `items`, including those inside a choice's options */
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

// A card's items, then those of the cards inside it
function itemsOfCard(card: Card): CardItem[] {
  return [...card.items, ...card.cards.flatMap(itemsOfCard)];
}

function allEntries(section: FormSection): SectionEntry[] {
  return [...section.entries, ...(section.tables ?? []).flatMap((table) => table.entries)];
}

/**
 * Collect every operation string across all sections
 */
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
