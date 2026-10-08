export interface OutputFormat {
  colored: boolean;
  width: number;
}

const MAX_WIDTH = 100;
const DEFAULT_WIDTH = 80;

export const PLAIN: OutputFormat = { colored: false, width: DEFAULT_WIDTH };

export function createOutputFormat(stream: NodeJS.WriteStream): OutputFormat {
  return {
    colored: stream.hasColors?.() ?? false,
    width: Math.min(stream.columns || DEFAULT_WIDTH, MAX_WIDTH),
  };
}

export function highlightTitle(text: string, format: OutputFormat): string {
  return format.colored ? `\x1b[1;33m${text}\x1b[0m` : text;
}

export function highlight(text: string, format: OutputFormat): string {
  return format.colored ? `\x1b[36m${text}\x1b[39m` : text;
}
