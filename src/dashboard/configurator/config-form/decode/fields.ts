import { Document, isSeq } from 'yaml';

import type {
  AmountField,
  BooleanField,
  CheckboxesField,
  ColorField,
  EmbeddingModelField,
  Field,
  FieldBase,
  FieldKind,
  FieldOf,
  FileField,
  LinesField,
  MembershipField,
  NumberField,
  PickListField,
  SecretField,
  SelectField,
  TemplateField,
  TextField,
  UrlField,
} from '../config-fields';
import {
  PICK_ADD,
  PICK_DRAWN,
  PICK_REMOVE,
  composeUnit,
  entraIssuerFor,
  withHttpsScheme,
} from '../config-fields';
import { sshRemoteUrl } from '../../../../forge/remote-url';
import { SECRET_MASK } from '../../../../global-ui/secret-mask';
import { Path, dottedPath, parseLines, writeAt, writeAtWithDefault } from '../document';
import { FormBody, submitted, submittedList } from './body';

/** Decode one field and report changes; applyForm controls which fields are allowed */
type Decoder<F extends FieldBase = FieldBase> = (
  doc: Document,
  body: FormBody,
  field: F,
  path: Path,
) => boolean;

const decodeBoolean: Decoder<BooleanField> = (doc, body, field, path) => {
  // Unchecked checkboxes submit nothing, so absence means false
  const value = submitted(body, field.path) === 'on' || submitted(body, field.path) === 'true';

  // Named switches clear the key only if it still names this entry
  if (field.trueValue !== undefined) {
    if (value) return writeAt(doc, path, field.trueValue);
    return doc.getIn(path) === field.trueValue ? writeAt(doc, path, undefined) : false;
  }

  return writeAtWithDefault(doc, path, value, field.fallback);
};

const decodeMembership: Decoder<MembershipField> = (doc, body, field, path) => {
  // Toggle this member without changing others; compare against the rendered list
  const on = submitted(body, field.path) === 'on' || submitted(body, field.path) === 'true';
  const member = field.trueValue ?? '';
  if (member === '') return false;
  if (on === field.values.includes(member)) return false;

  // Edit the existing sequence to preserve YAML formatting
  const node = doc.getIn(path, true);
  if (isSeq(node)) {
    if (on) node.items.push(doc.createNode(member));
    else node.items = node.items.filter((item) => seqItemValue(item) !== member);
    return true;
  }
  // Store an explicit empty list when off; leave validation to the loader
  return writeAt(doc, path, on ? [member] : []);
};

const decodeAmount: Decoder<AmountField> = (doc, body, field, path) => {
  // Without unit options, preserve the input as text, including variable references
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;
  const amount = raw.trim();
  if (field.unitOptions.length === 0) return writeAt(doc, path, amount);
  if (amount === '') return writeAt(doc, path, undefined);

  // Keep the displayed unit if none was submitted
  const unit = submitted(body, `unit:${field.path}`) ?? field.unit;
  return writeAtWithDefault(doc, path, composeUnit(field.kind, amount, unit), field.fallback);
};

const decodeTenant: Decoder = (doc, body, field, path) => {
  // Expand the tenant to an issuer URL; blank removes it
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;
  const tenant = raw.trim();
  return writeAt(doc, path, tenant === '' ? undefined : entraIssuerFor(tenant));
};

const decodeCheckboxes: Decoder<CheckboxesField> = (doc, body, field, path) => {
  const values = submittedList(body, field.path);
  // Store cleared selections as [] to override defaults; leave unchanged empty lists alone
  if (values.length === 0 && field.values.length === 0) return false;
  return writeAt(doc, path, values);
};

const decodePickList: Decoder<PickListField> = (doc, body, field, path) => {
  const added = `${PICK_ADD}${field.path}`;
  const removed = `${PICK_REMOVE}${field.path}`;
  const drawn = `${PICK_DRAWN}${field.path}`;

  if ([field.path, added, removed, drawn].every((name) => !(name in body))) return false;

  const dropped = new Set(submittedList(body, removed));
  const picked = submittedList(body, added)
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const values = [
    ...new Set([
      ...submittedList(body, field.path).filter((value) => !dropped.has(value)),
      ...picked,
    ]),
  ];

  if (values.length === 0 && field.values.length === 0) return false;
  return writeAt(doc, path, values);
};

const decodeMultiline: Decoder = (doc, body, field, path) => {
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;
  // Normalize browser-submitted CRLF to LF
  return writeAt(doc, path, raw.replace(/\r\n/g, '\n').trim());
};

const decodeLines: Decoder<LinesField> = (doc, body, field, path) => {
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;
  const values = parseLines(raw);
  // Do not persist an unchanged displayed default
  if (!doc.hasIn(path) && JSON.stringify(values) === JSON.stringify(field.fallback)) return false;
  if (field.fallback !== undefined) return writeAt(doc, path, values);
  return writeAt(doc, path, values.length > 0 ? values : undefined);
};

const decodeNumber: Decoder<NumberField> = (doc, body, field, path) => {
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (trimmed === '') return writeAt(doc, path, undefined);
  const value = Number(trimmed);
  // Preserve invalid input for loader validation
  return writeAtWithDefault(doc, path, Number.isFinite(value) ? value : trimmed, field.fallback);
};

const decodeFile: Decoder<FileField> = (doc, body, field, path) => {
  // The controller supplies uploads as data URIs; blank input keeps the stored file
  const raw = submitted(body, field.path);
  if (raw !== undefined && raw.trim() !== '') return writeAt(doc, path, raw.trim());

  // Remove the stored file only when explicitly requested
  if (submitted(body, `remove:${field.path}`) === 'on' && field.stored !== '') {
    return writeAt(doc, path, undefined);
  }
  return false;
};

const decodeSecret: Decoder<SecretField> = (doc, body, field, path) => {
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;

  // Copy from a server-defined path without exposing the secret to the page
  // Handle copying before blank input, since the secret control may be empty
  if (field.sourceToCopyFrom && submitted(body, `copy:${field.path}`) === 'on') {
    const source = dottedPath(field.sourceToCopyFrom);
    const value = doc.getIn(source);
    if (typeof value === 'string' && value !== '') return writeAt(doc, path, value);
  }

  // Treat the secret mask as empty input
  const typed = raw.trim() === SECRET_MASK ? '' : raw.trim();

  const unsaved = submitted(body, `unsaved:${field.path}`);
  if (typed === '' && unsaved !== undefined && unsaved.trim() !== '') {
    return writeAt(doc, path, unsaved.trim());
  }

  // Blank input must not erase a hidden secret
  if (typed === '' && field.secretHidden) return false;
  return writeAt(doc, path, typed);
};

const decodeText: Decoder<
  TextField | EmbeddingModelField | SelectField | TemplateField | ColorField
> = (doc, body, field, path) => {
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;
  return writeAtWithDefault(doc, path, raw.trim(), field.fallback);
};

/** Default to HTTPS and convert scp-style SSH remotes to ssh:// URLs */
const decodeUrl: Decoder<UrlField> = (doc, body, field, path) => {
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;
  return writeAtWithDefault(doc, path, withHttpsScheme(sshRemoteUrl(raw.trim())), field.fallback);
};

/** Require a correctly typed decoder for every field kind */
const DECODERS: { [K in FieldKind]: Decoder<FieldOf<K>> } = {
  text: decodeText,
  url: decodeUrl,
  'embedding-model': decodeText,
  select: decodeText,
  template: decodeText,
  color: decodeText,
  secret: decodeSecret,
  number: decodeNumber,
  boolean: decodeBoolean,
  multiline: decodeMultiline,
  'known-hosts': decodeMultiline,
  lines: decodeLines,
  checkboxes: decodeCheckboxes,
  'pick-list': decodePickList,
  file: decodeFile,
  membership: decodeMembership,
  duration: decodeAmount,
  bytes: decodeAmount,
  'entra-tenant': decodeTenant,
};

/** Apply a submitted field and return whether the document changed */
export function applyField(doc: Document, body: FormBody, field: Field): boolean {
  // The map enforces field/decoder pairing that TypeScript cannot infer here
  const decode = DECODERS[field.kind] as Decoder<Field>;
  return decode(doc, body, field, dottedPath(field.path));
}

/** Read a sequence item's string from either a raw string or a YAML scalar */
function seqItemValue(item: unknown): string | null {
  if (typeof item === 'string') return item;
  const value = (item as { value?: unknown } | null)?.value;
  return typeof value === 'string' ? value : null;
}
