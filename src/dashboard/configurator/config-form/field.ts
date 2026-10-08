/**
 * The field constructor, and every transform between a stored value and a
 * control's value
 *
 * `field()` is the one place a path into the document becomes something the
 * view can render. The kinds that do not store what they show are all settled
 * here, each as a pair that takes a value apart and puts it back together:
 * `unitsOf`/`composeUnit` for a duration or a size, `entraTenantOf`/
 * `entraIssuerFor` for a tenant inside an issuer URL. Nothing else does either
 *
 * `at` and `Obj` read the plain tree `doc.toJS()` produced, which is not what
 * `document.ts` operates on — that module writes to the yaml `Document`
 */

import { linesOf, scalarString } from './document';
import { renderHelp } from './help';
import type { Field, FieldKind, FieldUpload, Option, TableColumn } from './model';

const PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export function isEnvPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && PLACEHOLDER.test(value);
}

export type Obj = Record<string, unknown>;

export function at(root: unknown, path: (string | number)[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Obj)[key as string];
  }
  return node;
}

export interface FieldOptions {
  help?: string;
  // For membership fields, the value that makes the field checked
  trueValue?: string;
  pattern?: string;
  patternHint?: string;
  placeholder?: string;
  options?: Option[];
  rows?: number;
  fallback?: unknown;
  label?: string;
  stored?: string;
  storedFile?: string;
  // Media types a file picker offers; see `Field.accept`
  accept?: string;
  // Sub-fields attached after this one
  attached?: Field[];
  // True when the field is irrelevant to the current context
  inapplicable?: boolean;
  // Whether this field starts a new row
  startsRow?: boolean;
  // Path to another field that must be non-empty for visibility
  shownWith?: string;
  // Path to another field whose value can be copied here
  copiedFrom?: string;
  // True when the copied value is hidden because the source is already stored
  copiedStored?: boolean;
  // Markdown for a contextual link beside the field
  link?: string;
  // Markdown for an informational fact below the field
  fact?: string;
  // Content to copy to the clpboard
  copy?: string;
  // Form rebuilds when changed
  reshapes?: boolean;
  // Upload config for secrets
  upload?: FieldUpload;
  // Whether the field is advanced-mode only
  advanced?: boolean;
  // Path to the field this one's value determines the width of. See `Field.widthInto`
  widthInto?: string;
}

const DEFAULTED_KINDS = new Set<FieldKind>(['text', 'number', 'duration', 'bytes']);

export function field(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  kind: FieldKind,
  options: FieldOptions = {},
): Field {
  const stored = at(root, path);
  // Use fallback only when stored is absent and the kind participates
  const raw =
    stored === undefined && DEFAULTED_KINDS.has(kind) && options.fallback !== undefined
      ? options.fallback
      : stored;
  const dotted = path.join('.');

  const inapplicable = options.inapplicable === true;

  const secretHidden = kind === 'secret' && stored !== undefined && !isEnvPlaceholder(stored);

  const units = unitsFor(kind);
  const split =
    units.length === 0
      ? null
      : raw === undefined || scalarString(raw).trim() === ''
        ? { amount: '', unit: (unitsOf(kind, options.fallback) ?? { unit: units[0].value }).unit }
        : unitsOf(kind, raw);

  return {
    path: dotted,
    schemaPath,
    label: options.label ?? label,
    kind,
    // File fields show empty; secrets show empty when hidden; inapplicable fields show empty
    value:
      inapplicable || secretHidden || kind === 'file'
        ? ''
        : // Duration and bytes split their stored value into amount and unit
          split !== null
          ? split.amount
          : kind === 'lines'
            ? linesOf(raw)
            : // Entra-tenant extracts the tenant from a full issuer URL
              kind === 'entra-tenant'
              ? (entraTenantOf(scalarString(raw)) ?? '')
              : scalarString(raw),

    checked:
      options.trueValue !== undefined
        ? // Membership checks whether trueValue appears in the stored array
          kind === 'membership'
          ? Array.isArray(raw) && raw.map((v) => scalarString(v)).includes(options.trueValue)
          : raw === options.trueValue
        : raw === undefined
          ? options.fallback === true
          : raw === true,
    values: Array.isArray(raw) ? raw.map((v) => scalarString(v)) : [],
    options: options.options ?? [],
    help: options.help ?? '',
    helpHtml: renderHelp(options.help ?? ''),
    // For split fields the placeholder applies only to the amount part
    placeholder:
      split === null
        ? (options.placeholder ?? '')
        : (unitsOf(kind, options.placeholder)?.amount ?? ''),
    secretHidden,
    rows: options.rows ?? 4,
    fallback: options.fallback,
    stored: options.stored ?? '',
    storedFile: options.storedFile ?? '',
    accept: options.accept ?? '',
    attached: options.attached ?? [],
    inapplicable,
    startsRow: options.startsRow === true,
    advanced: options.advanced === true,
    reshapes: options.reshapes === true,
    unitOptions:
      split === null ? [] : units.map((each) => ({ value: each.value, label: each.label })),
    unit: split?.unit ?? '',
    trueValue: options.trueValue,
    pattern: options.pattern ?? '',
    patternHint: options.patternHint ?? '',
    shownWith: options.shownWith,
    copiedFrom: options.copiedFrom,
    widthInto: options.widthInto,
    copiedStored: options.copiedStored,
    linkHtml: renderHelp(options.link ?? ''),
    factHtml: renderHelp(options.fact ?? ''),
    copy: options.copy,
    upload: options.upload,
  };
}

export const SECRET_HELP =
  'The secret can be entered directly, which stores it in the database, or as a ' +
  'reference to an environment variable such as `${MY_SECRET}.`' +
  'On a self-hosted instance, set the variable where Speicher runs, for example ' +
  'under `environment:` in `docker-compose.yml`, and restart Speicher. The name must ' +
  'not start with `SPEICHER_`. Learn more about ' +
  '[secrets](https://docs.speicher.md/operate/configuration).';

interface Unit {
  value: string;
  label: string;
  scale?: number;
}

const DURATION_UNITS: Unit[] = [
  { value: 's', label: 'seconds' },
  { value: 'm', label: 'minutes' },
  { value: 'h', label: 'hours' },
  { value: 'd', label: 'days' },
];

const BYTE_UNITS: Unit[] = [
  { value: 'B', label: 'bytes', scale: 1 },
  { value: 'KB', label: 'KB', scale: 1_000 },
  { value: 'MB', label: 'MB', scale: 1_000_000 },
  { value: 'GB', label: 'GB', scale: 1_000_000_000 },
];

function unitsFor(kind: FieldKind): Unit[] {
  if (kind === 'duration') return DURATION_UNITS;
  if (kind === 'bytes') return BYTE_UNITS;
  return [];
}

function unitsOf(kind: FieldKind, raw: unknown): { amount: string; unit: string } | null {
  const units = unitsFor(kind);
  if (units.length === 0) return null;

  if (kind === 'duration') {
    // Matches a number followed by a unit suffix, e.g. 15m, 30d
    const match = /^([0-9]+)([a-z]+)$/.exec(scalarString(raw).trim());
    const unit = units.find((each) => each.value === match?.[2]);
    return match && unit ? { amount: match[1], unit: unit.value } : null;
  }

  const text = scalarString(raw).trim();
  if (!/^[0-9]+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return null;

  // Pick the largest unit that divides the value evenly
  const unit =
    value === 0
      ? units[0]
      : ([...units].reverse().find((each) => value % (each.scale ?? 1) === 0) ?? units[0]);
  return { amount: String(value / (unit.scale ?? 1)), unit: unit.value };
}

/**
 * Recombine a split amount and unit into the stored format
 */
export function composeUnit(kind: FieldKind, amount: string, unit: string): string | number {
  const units = unitsFor(kind);
  const chosen = units.find((each) => each.value === unit) ?? units[0];

  if (kind === 'duration') return `${amount}${chosen?.value ?? ''}`;

  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  return value * (chosen?.scale ?? 1);
}

// Matches Entra ID issuer URL and captures the tenant GUID
const ENTRA_ISSUER = /^https:\/\/login\.microsoftonline\.com\/([^/\s]+)\/v2\.0$/;

export function entraTenantOf(issuer: string): string | null {
  return ENTRA_ISSUER.exec(issuer.trim())?.[1] ?? null;
}

export function entraIssuerFor(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant.trim()}/v2.0`;
}

export function unavailableOption(option: Option, reason: string): Option {
  return { ...option, unavailable: reason, unavailableHtml: renderHelp(reason) };
}

export function column(label: string, help = ''): TableColumn {
  return { label, help, helpHtml: '' };
}
