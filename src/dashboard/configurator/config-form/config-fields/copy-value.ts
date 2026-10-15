/**
 * A value shown read-only with a button that copies it
 */

export interface CopyValueItem {
  kind: 'copy-value';
  label: string;
  // The value to copy. If this value starts with `/`, it is a path on this instance, and the
  // browser puts its own address in front
  text: string;
  // Markdown shown below the value, e.g. where to enter it
  note: string;
  // Places the value at the start of a new grid row
  startsRow: boolean;
  // Spans two columns of the grid, e.g. for a long URL
  wide: boolean;
}

export interface CopyValueOptions {
  startsRow?: boolean;
  wide?: boolean;
}

/**
 * copyValue builds a value shown read-only with a button that copies it.
 *
 * @param label the label above the value
 * @param text the value to copy
 * @param note the markdown shown below the value
 * @param options where the value sits in the grid. By default it starts a new row and spans one column
 */
export function copyValue(
  label: string,
  text: string,
  note = '',
  options: CopyValueOptions = {},
): CopyValueItem {
  return {
    kind: 'copy-value',
    label,
    text,
    note,
    startsRow: options.startsRow ?? true,
    wide: options.wide ?? false,
  };
}
