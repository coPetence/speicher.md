/**
 * FieldBase includes the shared properties of every config field and the builder for the base field
 */

import type { Field } from '.';
import type { FieldStatus } from '../model';

export type Obj = Record<string, unknown>;

// Reads the value at `path` into Obj, or undefined when a step along the way is missing
export function at(root: unknown, path: (string | number)[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Obj)[key as string];
  }
  return node;
}

export interface FieldBase {
  // Where the value lives in the instance configuration, dot-separated, e.g. `forges.github.app_id`
  path: string;
  // The same path with member keys and list positions as `<key>` and `<index>`,
  // e.g. `forges.<key>.app_id`
  schemaPath: string;
  label: string;
  // Markdown shown in the info popover beside the label
  help: string;
  // Markdown shown as a note below the control
  fact: string;
  // Markdown shown below the field, e.g. a link to the identity provider's portal
  link: string;
  // Places the field at the start of a new grid row
  startsRow: boolean;
  // Spans two columns of the grid, e.g. for a URL
  wide: boolean;
  // Shows the field under the collapsed "Advanced settings" instead of on the page
  advanced: boolean;
  // Draws a field of the page after the page's cards instead of before them
  trailing: boolean;
  // Marks the label with an asterisk, because the configuration needs a value here
  required: boolean;
  // Renders only a hidden empty input, which clears the stored value on save,
  // because the field does not apply here
  // TODO check if this makes sense
  inapplicable: boolean;
  // Fields rendered inside this one, after its control
  attached: Field[];
  // Path of a checkbox or select; the field is hidden while that control is
  // unchecked or empty, and still submits its value
  shownWith?: string;
  // A list the field depends on, and how many rows it holds; the field is hidden
  // while the list holds none, and still submits its value
  shownWithRows?: { collection: string; rows: number };
  // Result of the field's live check, shown below the control
  status?: FieldStatus;
  // URL of the field's live check. While `status` is absent the page links to it and
  // the browser runs it, so a slow remote never holds up the page
  checkHref?: string;
}

export interface BaseOptions {
  // Replaces the label passed to the builder
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
