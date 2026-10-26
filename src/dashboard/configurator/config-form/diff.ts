/**
 * Diff two admin config YAMLs for display
 *
 * A standard Myers diff with LCS, then collapsed to show only
 * CONTEXT lines of context around each change
 * The hiddenChanges field lists secrets whose value changed
 * but whose redacted form did not, so the change is invisible in UI
 *
 * Not using an off-shelf diff library to keep the bundle small
 */
import { loadDocument } from './document';
import { buildSections } from './fields';
import { allFields } from './model';
import { REDACTED, displayYaml } from './redact';

export type DiffKind = 'same' | 'add' | 'remove' | 'gap';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
  hidden?: DiffLine[];
}

export interface ConfigDiff {
  lines: DiffLine[];
  // Fields whose raw value changed but whose redacted display stayed the same
  hiddenChanges: string[];
  identical: boolean;
  added: number;
  removed: number;
}

const CONTEXT = 3;

// Product of line counts above which full LCS is skipped
const MAX_CELLS = 4_000_000;

export function diffConfigVersions(fromYaml: string, toYaml: string): ConfigDiff {
  const from = displayYaml(fromYaml);
  const to = displayYaml(toYaml);

  const lines = collapse(diffLines(from.split('\n'), to.split('\n')));
  return {
    lines,
    hiddenChanges: hiddenSecretChanges(fromYaml, toYaml),
    identical: from === to,
    added: lines.filter((l) => l.kind === 'add').length,
    removed: lines.filter((l) => l.kind === 'remove').length,
  };
}

// Strips the common prefix and suffix, then diffs the remaining middle
function diffLines(a: string[], b: string[]): DiffLine[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) {
    out.push({ kind: 'same', text: a[i], oldNumber: i + 1, newNumber: i + 1 });
  }
  out.push(...diffMiddle(midA, midB, head));
  for (let i = 0; i < tail; i++) {
    const oldIndex = a.length - tail + i;
    const newIndex = b.length - tail + i;
    out.push({ kind: 'same', text: a[oldIndex], oldNumber: oldIndex + 1, newNumber: newIndex + 1 });
  }
  return out;
}

// Myers LCS on the middle lines, or a fallback full-remove / full-add when
// the matrix would exceed MAX_CELLS
function diffMiddle(a: string[], b: string[], offset: number): DiffLine[] {
  if (a.length === 0 && b.length === 0) return [];

  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text, i) => line('remove', text, offset + i + 1, null)),
      ...b.map((text, i) => line('add', text, null, offset + i + 1)),
    ];
  }

  // LCS table built bottom-up
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // Walk the LCS table to emit same / add / remove lines
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(line('same', a[i], offset + i + 1, offset + j + 1));
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(line('remove', a[i], offset + i + 1, null));
      i++;
    } else {
      out.push(line('add', b[j], null, offset + j + 1));
      j++;
    }
  }
  while (i < a.length) out.push(line('remove', a[i], offset + i++ + 1, null));
  while (j < b.length) out.push(line('add', b[j], null, offset + j++ + 1));
  return out;
}

function line(
  kind: DiffKind,
  text: string,
  oldNumber: number | null,
  newNumber: number | null,
): DiffLine {
  return { kind, text, oldNumber, newNumber };
}

// Keeps only lines within CONTEXT of any change, replacing skipped runs
// with a single gap line
function collapse(lines: DiffLine[]): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((entry, index) => {
    if (entry.kind === 'same') return;
    for (
      let i = Math.max(0, index - CONTEXT);
      i <= Math.min(lines.length - 1, index + CONTEXT);
      i++
    ) {
      keep[i] = true;
    }
  });

  const out: DiffLine[] = [];
  let skipped: DiffLine[] = [];
  lines.forEach((entry, index) => {
    if (keep[index]) {
      if (skipped.length > 0) {
        out.push(gap(skipped));
        skipped = [];
      }
      out.push(entry);
      return;
    }
    skipped.push(entry);
  });
  if (skipped.length > 0 && out.length > 0) out.push(gap(skipped));
  return out;
}

function gap(hidden: DiffLine[]): DiffLine {
  const count = hidden.length;
  return { ...line('gap', `${count} unchanged line${count === 1 ? '' : 's'}`, null, null), hidden };
}

// Returns paths whose raw value changed but whose redacted display is identical
function hiddenSecretChanges(fromYaml: string, toYaml: string): string[] {
  const before = secretValues(fromYaml);
  const after = secretValues(toYaml);
  const paths = new Set([...before.keys(), ...after.keys()]);

  const changed: string[] = [];
  for (const path of [...paths].sort()) {
    const a = before.get(path);
    const b = after.get(path);
    if (a === b) continue;
    // Redacted form is either the env-var literal or the placeholder string;
    // if it hasn't changed the UI can't show the difference
    if (redactedForm(a) !== redactedForm(b)) continue;
    changed.push(path);
  }
  return changed;
}

function secretValues(yaml: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  let doc;
  try {
    doc = loadDocument(yaml);
  } catch {
    return out;
  }
  const parsed = doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  for (const field of allFields(buildSections(doc))) {
    if (field.kind !== 'secret') continue;
    out.set(field.path, valueAt(parsed, field.path.split('.')));
  }
  return out;
}

function valueAt(root: unknown, path: string[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

// ${VARIABLE} patterns are shown as-is, everything else is REDACTED
function redactedForm(value: unknown): unknown {
  if (value === undefined) return undefined;
  return typeof value === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
    ? value
    : REDACTED;
}
