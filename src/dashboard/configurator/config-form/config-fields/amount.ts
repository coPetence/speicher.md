/**
 * A duration or a size, typed as a number beside a unit dropdown
 *
 * The configuration stores a duration as one string such as `15m`, and a size as a
 * number of bytes; the page splits either into an amount and a unit. A stored value
 * that does not split, e.g. `${VAR}`, is shown in a plain text box instead
 */

import { DURATION_UNITS, splitDuration } from '../../../../common/time';
import { scalarString } from '../document';
import type { Option } from '../model';
import type { BaseOptions, FieldBase } from './base';
import { at, baseField } from './base';

export type AmountKind = 'duration' | 'bytes';

export interface AmountField extends FieldBase {
  kind: AmountKind;
  // The amount without its unit, or the whole stored value when it does not split
  value: string;
  // Value used while the key is absent: a string such as `1h` for a duration, a
  // number of bytes for a size
  fallback?: string | number;
  // The unit the amount is in
  unit: string;
  // The units the dropdown offers; empty when the stored value does not split
  unitOptions: Option[];
  // The amount part of the placeholder
  placeholder: string;
}

export interface AmountOptions<V extends string | number = string | number> extends BaseOptions {
  fallback?: V;
  placeholder?: string;
}

// Sizes in the configuration are plain byte counts; the form offers these steps of 1000
const BYTE_UNITS = [
  { unit: 'B', label: 'bytes', bytes: 1 },
  { unit: 'KB', label: 'KB', bytes: 1_000 },
  { unit: 'MB', label: 'MB', bytes: 1_000_000 },
  { unit: 'GB', label: 'GB', bytes: 1_000_000_000 },
] as const;

function unitOptionsFor(kind: AmountKind): Option[] {
  const units = kind === 'duration' ? DURATION_UNITS : BYTE_UNITS;
  return units.map((each) => ({ value: each.unit, label: each.label }));
}

// Splits a stored value into amount and unit, or null when it does not split
function splitAmount(kind: AmountKind, raw: unknown): { amount: string; unit: string } | null {
  const text = scalarString(raw).trim();

  if (kind === 'duration') {
    const split = splitDuration(text);
    return split ? { amount: String(split.amount), unit: split.unit } : null;
  }

  if (!/^[0-9]+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return null;

  // The largest unit that divides the value evenly, so 2000000 reads as 2 MB
  const unit =
    value === 0
      ? BYTE_UNITS[0]
      : ([...BYTE_UNITS].reverse().find((each) => value % each.bytes === 0) ?? BYTE_UNITS[0]);
  return { amount: String(value / unit.bytes), unit: unit.unit };
}

/** Recombines an amount and a unit into the stored format */
export function composeUnit(kind: AmountKind, amount: string, unit: string): string | number {
  if (kind === 'duration') {
    const chosen = DURATION_UNITS.find((each) => each.unit === unit) ?? DURATION_UNITS[0];
    return `${amount}${chosen.unit}`;
  }

  const chosen = BYTE_UNITS.find((each) => each.unit === unit) ?? BYTE_UNITS[0];
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  return value * chosen.bytes;
}

function amountField(
  kind: AmountKind,
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: AmountOptions,
): AmountField {
  const base = baseField(path, schemaPath, label, options);
  const raw = at(root, path) ?? options.fallback;
  // An empty box still offers the units, starting on the fallback's or the smallest
  const split =
    raw === undefined || scalarString(raw).trim() === ''
      ? {
          amount: '',
          unit: splitAmount(kind, options.fallback)?.unit ?? unitOptionsFor(kind)[0].value,
        }
      : splitAmount(kind, raw);

  return {
    ...base,
    kind,
    value: base.inapplicable ? '' : split ? split.amount : scalarString(raw),
    fallback: options.fallback,
    unit: split?.unit ?? '',
    unitOptions: split ? unitOptionsFor(kind) : [],
    placeholder: split
      ? (splitAmount(kind, options.placeholder)?.amount ?? '')
      : (options.placeholder ?? ''),
  };
}

export function durationField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: AmountOptions<string> = {},
): AmountField {
  return amountField('duration', root, path, schemaPath, label, options);
}

export function bytesField(
  root: unknown,
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: AmountOptions<number> = {},
): AmountField {
  return amountField('bytes', root, path, schemaPath, label, options);
}
