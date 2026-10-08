import { OutputFormat, PLAIN, highlightTitle } from './format';

/** Lays out rows as columns under a header, each column as wide as its widest cell */
export function formatTable(
  header: string[],
  rows: string[][],
  format: OutputFormat = PLAIN,
): string {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]))
      .join('  ')
      .trimEnd();
  // Coloured after padding: the escape codes would otherwise count towards the width
  return [highlightTitle(line(header), format), ...rows.map(line)].join('\n') + '\n';
}
