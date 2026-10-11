import { Document, isSeq } from 'yaml';

import { composeUnit, entraIssuerFor, withHttpsScheme } from '../config-fields';
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
  MembershipField,
  NumberField,
  SecretField,
  SelectField,
  TemplateField,
  TextField,
  UrlField,
} from '../config-fields';
import { Path, dottedPath, parseLines, writeAt, writeAtWithDefault } from '../document';
import { FormBody, submitted, submittedList } from './body';

/**
 * One field's submitted value into the document; true when the document changed.
 *
 * The caller decides *which* fields — that is the field model's gate, and it lives
 * in `applyForm`. This file only says what one control's answer means.
 */
type Decoder<F extends FieldBase = FieldBase> = (
  doc: Document,
  body: FormBody,
  field: F,
  path: Path,
) => boolean;

const decodeBoolean: Decoder<BooleanField> = (doc, body, field, path) => {
  // An unticked checkbox sends nothing at all, which is how HTML says false —
  // so absence here is a value rather than "not submitted", and this is the one
  // kind that cannot distinguish the two.
  const value = submitted(body, field.path) === 'on' || submitted(body, field.path) === 'true';

  // A switch that answers "is this the one" writes a *name*, not a boolean —
  // see `Field.trueValue`. Unticking clears the key only while it still names
  // this entry: every provider's page carries this control, and one of them is
  // always off, so reading an absent checkbox as "clear it" would have the
  // pages fight over a key naming one of them.
  if (field.trueValue !== undefined) {
    if (value) return writeAt(doc, path, field.trueValue);
    return doc.getIn(path) === field.trueValue ? writeAt(doc, path, undefined) : false;
  }

  return writeAtWithDefault(doc, path, value, field.fallback);
};

const decodeMembership: Decoder<MembershipField> = (doc, body, field, path) => {
  /*
    A switch over one entry of a list. Ticked puts this name in, unticked takes
    it out, and **neither touches the names beside it** — which is the whole
    reason this is not decoded as a `checkboxes` field with one option. That
    one writes the submitted selection over the stored list, so a group's page
    would post one name and delete every other administrator group on the
    instance, from a form that never showed them.

    `field.values` is the stored list, read out of the document when the form
    was built, so the comparison is against what this page was rendered with.
    An unticked box submits nothing at all, so absence is a value here exactly
    as it is for `trueValue` on a scalar key.
  */
  const on = submitted(body, field.path) === 'on' || submitted(body, field.path) === 'true';
  const member = field.trueValue ?? '';
  if (member === '') return false;
  if (on === field.values.includes(member)) return false;

  /*
    The list is *edited*, not replaced, where one already exists — one item
    pushed or one item taken out. Writing a fresh node would be the same
    document and a different file: `createNode` produces a block sequence, so
    `groups: [platform-ops]` came back as two indented lines and the diff for
    "this group is an admin group now" was the whole block. The rule that the
    document is edited rather than rebuilt is the same one that keeps comments
    and key order, and a list's style is part of it.
  */
  const node = doc.getIn(path, true);
  if (isSeq(node)) {
    if (on) node.items.push(doc.createNode(member));
    else node.items = node.items.filter((item) => seqItemValue(item) !== member);
    return true;
  }
  // Nothing there yet. An empty list is written rather than the key removed:
  // "nobody" is an answer, and the loader is where "this block must resolve to
  // somebody" gets said.
  return writeAt(doc, path, on ? [member] : []);
};

const decodeAmount: Decoder<AmountField> = (doc, body, field, path) => {
  /*
    Two controls, one value. The amount arrives under the field's own name and
    the unit under a name derived from it — the same shape the logo's remove
    box and the secret's copy box use, and for the same reason: it is not a
    path of its own, so nothing about "only paths the form offered" changes.

    A field that did not split is a plain text box holding what the document
    says — a `${VAR}`, or a value this cannot read — and is decoded as one, or
    opening the page would rewrite it. `unitOptions` is the same fact the page
    rendered from, read here off a model built from the same document.
  */
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;
  const amount = raw.trim();
  if (field.unitOptions.length === 0) return writeAt(doc, path, amount);
  if (amount === '') return writeAt(doc, path, undefined);

  /*
    An absent unit means the one the page was showing, not the base one.

    A select always submits, so this is not about browsers — it is about what
    "not submitted" has to mean everywhere on this form: leave it as it was. The
    alternative reads a body carrying only the amount as a request to reinterpret
    `1h` as one second, which is a silent hundred-fold change to a value nobody
    typed. `field.unit` is the model's, built from the same document the page was
    built from.
  */
  const unit = submitted(body, `unit:${field.path}`) ?? field.unit;
  return writeAtWithDefault(doc, path, composeUnit(field.kind, amount, unit), field.fallback);
};

const decodeTenant: Decoder = (doc, body, field, path) => {
  // The control holds the part that varies; the document holds the whole URL,
  // because that is what the loader and the OIDC client read. Blank removes
  // the issuer rather than leaving the old one behind — an operator who
  // emptied the field asked for something, and the something is refused by the
  // loader, which is the right place for "an OIDC provider needs an issuer" to
  // be said.
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;
  const tenant = raw.trim();
  return writeAt(doc, path, tenant === '' ? undefined : entraIssuerFor(tenant));
};

const decodeCheckboxes: Decoder<CheckboxesField> = (doc, body, field, path) => {
  const values = submittedList(body, field.path);
  // An empty selection is a real answer — "tell nobody" — and is written as an
  // empty list rather than removed, or it would fall back to the default and
  // start mailing the people who were just unticked. But only once somebody has
  // actually unticked something: an absent key that is still absent stays that
  // way rather than becoming `[]` on the first save.
  if (values.length === 0 && field.values.length === 0) return false;
  return writeAt(doc, path, values);
};

const decodeMultiline: Decoder = (doc, body, field, path) => {
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;
  // A textarea normalises newlines to CRLF on submit; the document should not
  // acquire carriage returns because somebody looked at a host key.
  return writeAt(doc, path, raw.replace(/\r\n/g, '\n').trim());
};

const decodeLines: Decoder = (doc, body, field, path) => {
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;
  const values = parseLines(raw);
  return writeAt(doc, path, values.length > 0 ? values : undefined);
};

const decodeNumber: Decoder<NumberField> = (doc, body, field, path) => {
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (trimmed === '') return writeAt(doc, path, undefined);
  const value = Number(trimmed);
  // A value that is not a number is left for the loader to reject by name,
  // rather than being silently coerced to 0 or dropped here.
  return writeAtWithDefault(doc, path, Number.isFinite(value) ? value : trimmed, field.fallback);
};

const decodeFile: Decoder<FileField> = (doc, body, field, path) => {
  // The controller writes the upload in here as a `data:` URI before decoding
  // starts, so a file arrives by the same door as every other value and the
  // rule that only rendered paths can be written still holds. Nothing chosen
  // means nothing submitted, which means keep what is stored — the same shape
  // as a blank secret box, and for the same reason: an operator who did not
  // touch the picker did not ask to remove their logo. Removing it is the cross
  // in the row above it.
  const raw = submitted(body, field.path);
  if (raw !== undefined && raw.trim() !== '') return writeAt(doc, path, raw.trim());

  // The cross on the stored-value row — a checkbox drawn as one, and a field
  // rather than one of the structural operations above: those carry the *shape*
  // of the document, and a logo is a value. So removing one is decoded by the
  // save itself rather than costing a round trip, and the row stays on screen
  // struck through until the save happens, which is what makes it undoable. Its
  // name is derived from this field's own path, so it is still a write to a path
  // the form rendered: an invented `remove:` name reaches nothing.
  if (submitted(body, `remove:${field.path}`) === 'on' && field.stored !== '') {
    return writeAt(doc, path, undefined);
  }
  return false;
};

const decodeSecret: Decoder<SecretField> = (doc, body, field, path) => {
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;

  /*
    "Use the one stored over there" — the copy the page could not make.

    The source is a literal the form never renders, so there is nothing on
    screen for the island to take; the tick box says to take it here instead,
    and the value goes from the document into the document without ever
    reaching a page. Which value that is comes from the **field model** —
    `sourceToCopyFrom` is built by the server — so a body cannot name a path of its
    own to read, which is the property that matters on the form that writes
    `admins`. The box only exists on a field the model gave a source.

    Ahead of the blank check below, because the box is ticked *with* an empty
    control: that is the whole case.
  */
  if (field.sourceToCopyFrom && submitted(body, `copy:${field.path}`) === 'on') {
    const source = dottedPath(field.sourceToCopyFrom);
    const value = doc.getIn(source);
    if (typeof value === 'string' && value !== '') return writeAt(doc, path, value);
  }

  // Blank against a hidden literal means "leave it alone". The form never
  // rendered the value, so a blank box is what an operator sees when they have
  // not touched it — treating that as a deletion would silently unconfigure a
  // credential on every save.
  if (raw.trim() === '' && field.secretHidden) return false;
  return writeAt(doc, path, raw.trim());
};

const decodeText: Decoder<
  TextField | EmbeddingModelField | SelectField | TemplateField | ColorField
> = (doc, body, field, path) => {
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;
  return writeAtWithDefault(doc, path, raw.trim(), field.fallback);
};

/** An address keeps the scheme it was given, or is read as meaning https */
const decodeUrl: Decoder<UrlField> = (doc, body, field, path) => {
  const raw = submitted(body, field.path);
  if (raw === undefined) return false;
  return writeAtWithDefault(doc, path, withHttpsScheme(raw.trim()), field.fallback);
};

/**
 * Which decoder reads which kind of control.
 *
 * A map rather than a `switch` with a `default`, so a kind added to `FieldKind`
 * fails to compile until somebody says how it decodes. A `default` reads an
 * unknown kind as a trimmed text box, which for a control whose absence is a
 * value — a switch, a membership — is a silent write. Each decoder receives the
 * field of its own kind.
 */
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
  lines: decodeLines,
  checkboxes: decodeCheckboxes,
  file: decodeFile,
  membership: decodeMembership,
  duration: decodeAmount,
  bytes: decodeAmount,
  'entra-tenant': decodeTenant,
};

/** Apply one field's submitted value; true when the document actually changed. */
export function applyField(doc: Document, body: FormBody, field: Field): boolean {
  // TypeScript cannot follow that `DECODERS[field.kind]` takes this very field, so the
  // lookup is widened to take any; the map above is what guarantees the pairing
  const decode = DECODERS[field.kind] as Decoder<Field>;
  return decode(doc, body, field, dottedPath(field.path));
}

/**
 * A sequence item's string value, in either shape it comes in.
 *
 * The same two representations a map key has — parsed from the document it is a
 * `Scalar` with a `.value`, written by this process it is a plain string — and the
 * same bug if only one is matched: a name added and then removed in the same
 * session would survive the removal.
 */
function seqItemValue(item: unknown): string | null {
  if (typeof item === 'string') return item;
  const value = (item as { value?: unknown } | null)?.value;
  return typeof value === 'string' ? value : null;
}
