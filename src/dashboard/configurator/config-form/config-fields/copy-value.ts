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
}

export function copyValue(label: string, text: string, note = ''): CopyValueItem {
  return { kind: 'copy-value', label, text, note };
}
