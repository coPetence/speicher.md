/**
 * The config form's vocabulary
 *
 * Every type the form is made of, and the three walks over them. Nothing here
 * reads a document or builds a value: `field.ts` constructs a `Field`,
 * `sections/` assembles them into a `FormSection`, and the view, the decoder
 * and `/-/search` all read the result through these names
 *
 * It deliberately imports nothing. `collections.ts` needs the types and the
 * walks, and the section builders need `collections.ts`; a module with no
 * dependencies is what keeps that from being a cycle
 */

export type FieldKind =
  | 'text'
  | 'secret'
  | 'number'
  | 'boolean'
  | 'select'
  // Stored as a single string with embedded newlines (e.g used for pem certificates)
  | 'multiline'
  // Stored as an array of strings, one per line (e.g. used for provider domains)
  | 'lines'
  | 'checkboxes'
  // Theme-template picker showing a preview image per option
  | 'template'
  // File upload; stored value is the raw file content
  | 'file'
  // Hex colour input with a colour picker widget
  | 'color'
  // Membership: checked when trueValue appears in the stored array or matches
  | 'membership'
  // Duration or byte amount split into a number and a unit
  | 'duration'
  | 'bytes'
  // Text field that extracts an Entra tenant GUID from an issuer URL
  | 'entra-tenant';

export interface Option {
  value: string;
  label: string;
  // URL to a live preview (used for if FieldKind = template to render theme preview)
  previewHref?: string;
  // Suggested value for new-member creation (e.g. when creating Entra ID idp it can suggest a short id like entra-1)
  suggest?: string;
  // Brand mark identifier shown alongside the option (e.g. Entra ID Icon)
  mark?: string;
  // Plain-text reason the option is unavailable
  unavailable?: string;
  // Rendered HTML of the unavailable reason
  unavailableHtml?: string;
}
export interface FieldUpload {
  accept: string;
  content: 'rsa-private-key'; // only one option so far;
  // Button label for the upload control
  label: string;
  // Text shown in the drop rectangle when a file is dragged over it
  dropLabel: string;
}

export interface Field {
  // Dot-separated path into the config document
  path: string;
  // Schema path using `<key>` and `<index>` as placeholders
  schemaPath: string;
  label: string;
  kind: FieldKind;
  value: string;
  checked: boolean;
  values: string[];
  options: Option[];
  help: string;
  // Rendered HTML of the help text
  helpHtml: string;
  placeholder: string;
  // True when a secret has a stored literal (not an env var)
  secretHidden: boolean;
  rows: number;
  // Default used when stored value is absent for defaulted kinds
  fallback: unknown;
  // For membership fields, the value that makes the field checked
  trueValue?: string;
  // Override for the stored value shown to the user
  stored: string;
  // Override for the file name from a file upload
  storedFile: string;
  // Whether this field starts a new row in the form layout
  startsRow: boolean;
  // Whether the field is advanced-mode only (shown collapsed in the config pages)
  advanced: boolean;
  // Form rebuilds when changed
  reshapes: boolean;
  // Unit options for duration and bytes fields
  unitOptions: Option[];
  // Selected unit value for duration and bytes fields
  unit: string;
  // True when the field is irrelevant to the current context
  inapplicable: boolean;
  // Regex pattern for client-side validation
  pattern: string;
  // The pattern in words, shown when the browser refuses a value
  patternHint: string;
  // Sub-fields shown after this one
  attached: Field[];
  // Path to another field that must be non-empty for visibility
  shownWith?: string;
  /*
    Path to the control this value determines the width of.

    Entering the model's name asks the endpoint how wide its vectors are and writes
    the answer there, so a width the operator has to know is not typed from memory.
    The answer is written only into an empty box, or into one still holding the
    answer this page wrote itself, so a width typed by hand is never replaced. The
    island does the asking, on a model change and again when the box is emptied; the
    server answers it through the section's own save route with `intent=width` — the
    request a save would make, read the way a save reads it, without validating the
    rest of the document. Scriptless, nothing is asked and the box is typed by hand.
  */
  widthInto?: string;
  // Path to another field whose value can be copied here
  copiedFrom?: string;
  // Status indicator for this field
  status?: FieldStatus;
  /*
    URL that answers this field's own live check, offered when `status` is absent.

    `FormSection.checkHref`'s shape one level down, and for the identical reason: a
    request to somebody else's endpoint takes as long to fail as the timeout allows,
    so the page offers the check and never makes it. A provider's directory is the
    one user — the answer belongs under the switch that turns the lookup on rather
    than at the foot of a page that also configures an issuer and its claims, which
    is why this is a field's and not the section's.
  */
  checkHref?: string;
  // True when the copied value is hidden because the source is already stored (aka. copy cannot happen in the browser)
  copiedStored?: boolean;
  // Rendered link shown beside the field
  linkHtml: string;
  // Rendered fact shown below the field
  factHtml: string;
  // A value shown below the fact with a button that copies it. One starting with `/`
  // is a path on this instance, and the browser puts its own origin in front
  copy?: string;
  factForPathHtml: string;
  // Used when a value can be filled by a file upload (e.g. uploading a pem file to fill a string field) TODO: Rename to fillFromUpload
  upload?: FieldUpload;
}

export interface FieldStatus {
  level: 'ok' | 'warn' | 'fail';
  icon: string;
  label: string;
  detail: string;
}

export interface AddOp {
  op: string;
  label: string;
  // Label for the name input; null when the item has no name
  nameLabel: string | null;
  // Rendered help beside the name label; absent when the name needs no explaining
  nameHelpHtml?: string;
  // Regex pattern for the name; null when there is no name input
  namePattern: string | null;
  // namePattern in words; null when there is no name input
  nameHint: string | null;
  // Predefined name options
  nameOptions?: Option[];
  // Label for the type selector; null when there is no type choice
  typeLabel: string | null;
  typeOptions: Option[];
  // Whether this navigates to a new page rather than inserting inline
  opensPage?: boolean;
  // Direct URL instead of computing one from the op
  href?: string;
}

export interface EntryLine {
  label: string;
  value: string;
  // Provider mark identifier shown alongside the line (see `provider-marks.ts`)
  mark: string;
}

export interface SectionEntry {
  // URL to the entry's detail page; empty when there is no separate page
  href: string;
  // Primary display title
  title: string;
  // Secondary display text below the title
  subtitle: string;
  // The subtitle rendered by `renderHelp`, present only where it is prose — a
  // section's blurb read twice, on a page index. A member's subtitle is a kind or
  // a URL and is shown verbatim: run through `renderHelp` an `acme/my_repo_name`
  // would come back with its middle underlined
  subtitleHtml?: string;
  // Brand mark identifier shown alongside the entry (see `provider-marks.ts`)
  mark: string;
  // Lucide icon name for the entry tile
  icon: string;
  // Badges shown on the entry tile
  badges: { label: string; icon: string }[];
  // Summary lines shown in the entry listing
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
}

export interface TableColumn {
  label: string;
  help: string;
  // Rendered HTML of the help text
  helpHtml: string;
}

export interface ValueTable {
  // Section heading above the table
  title: string;
  // Column definitions
  columns: TableColumn[];
  bulkRemoveOp: string;
  entries: SectionEntry[];
  // Distinguishes group sources from person sources
  kind: string;
  // Text shown when the table is empty
  emptyNote: string;
}

export interface Card {
  title: string;
  // True when the title is a key in the document rather than a name somebody
  // wrote — a repository id, not "Stale repositories". It decides the face, the
  // way `entriesArePages` decides a tile's, and the default is the other way
  // round here because most cards are headings over a group of controls
  titleIsKey?: boolean;
  subtitle: string;
  removeOp: string | null;
  fields: Field[];
  cards: Card[];
  addOps: AddOp[];
  notes: string[];
  // Path to a switch on the page that must be on for the card to be shown. The
  // same attribute a field carries, read by the same island: hidden and never
  // removed, so every control inside still submits what it holds
  shownWith?: string;
}

export interface FormSection {
  // Status indicator at the section header
  status?: FieldStatus;
  // URL to a status check endpoint
  checkHref?: string;
  id: string;
  title: string;
  // Plain-text blurb rendered at the top of the section
  blurb: string;
  // Rendered HTML of the blurb
  blurbHtml: string;
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
  /*
    Operation string to take every answer on this page back out of the document.

    Not a removal: nothing is deleted from a collection and no member stops
    existing. What it clears is exactly the paths this section's own field model
    offers — which is why it is one op on the section rather than a list of paths
    in the decoder, and why a page whose controls move needs nothing changed here.
    Null when the page has no stored answer, so a button that would do nothing is
    never drawn.
  */
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
  // Whether the entry list is searchable
  searchable?: boolean;
  // Placeholder for the search input
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
  const walk = (card: Card) => {
    card.fields.forEach(push);
    card.cards.forEach(walk);
  };
  for (const section of sections) {
    section.fields.forEach(push);
    section.cards.forEach(walk);
    // Both top-level entries and table entries
    for (const entry of allEntries(section)) {
      entry.fields.forEach(push);
      entry.carried.forEach(push);
    }
  }
  return out;
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
    for (const table of section.tables ?? []) out.push(table.bulkRemoveOp);

    if (section.removeOp) out.push(section.removeOp);
    if (section.renameOp) out.push(section.renameOp);
    if (section.resetOp) out.push(section.resetOp);
    section.cards.forEach(walk);
  }
  return out;
}
