/**
 * Shared field properties and builder
 */

import type { Field } from '.';
import type { FieldStatus, FormProblem } from '../model';

export type Obj = Record<string, unknown>;

// Returns the value at path, or undefined if unreachable
export function at(root: unknown, path: (string | number)[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Obj)[key as string];
  }
  return node;
}

export interface FieldBase {
  // Dot-separated path in the instance config
  path: string;
  // Path with dynamic keys and list positions replaced by <key> and <index>
  schemaPath: string;
  label: string;
  // Markdown in the label's info popover
  help: string;
  // Markdown note below the control
  fact: string;
  // Markdown link below the field
  link: string;
  // Starts a new grid row
  startsRow: boolean;
  // Spans two grid columns
  wide: boolean;
  // Appears under collapsed "Advanced settings"
  advanced: boolean;
  // Appears after the page's cards
  trailing: boolean;
  // Requires a value and adds an asterisk to the label
  required: boolean;
  // Renders a hidden empty input to clear the value on save
  // TODO: Verify this behavior
  inapplicable: boolean;
  // Nested fields rendered after this control
  attached: Field[];
  // Hides when the referenced control is unchecked or empty; still submits
  shownWith?: string;
  // Hides when the referenced list has no rows; still submits
  shownWithRows?: { collection: string; rows: number };
  // Live check result shown below the control
  status?: FieldStatus;
  // Live check URL; linked and run by the browser when status is absent
  checkHref?: string;
  // Field-specific save errors that mark the control
  problems?: FormProblem[];
}

export interface BaseOptions {
  // Overrides the builder's label
  label?: string;
  help?: string;
  fact?: string;
  link?: string;
  startsRow?: boolean;
  wide?: boolean;
  advanced?: boolean;
  trailing?: boolean;
  required?: boolean;
  inapplicable?: boolean;
  attached?: Field[];
  shownWith?: string;
  shownWithRows?: { collection: string; rows: number };
}

export function baseField(
  path: (string | number)[],
  schemaPath: string,
  label: string,
  options: BaseOptions,
): FieldBase {
  return {
    path: path.join('.'),
    schemaPath,
    label: options.label ?? label,
    help: options.help ?? '',
    fact: options.fact ?? '',
    link: options.link ?? '',
    startsRow: options.startsRow === true,
    wide: options.wide === true,
    advanced: options.advanced === true,
    trailing: options.trailing === true,
    required: options.required === true,
    inapplicable: options.inapplicable === true,
    attached: options.attached ?? [],
    shownWith: options.shownWith,
    shownWithRows: options.shownWithRows,
  };
}
