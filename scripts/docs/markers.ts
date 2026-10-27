/**
 * Blocks run from <!-- generated: kind arg ... --> to <!-- /generated -->
 * Contents are regenerated and wrapped in prettier-ignore markers
 */

import { CodedError } from '../../src/common/errors';

/** Generation error with a code and optional file location */
export class DocsError extends CodedError {
  constructor(
    code: string,
    message: string,
    readonly file: string | null = null,
    readonly line: number | null = null,
  ) {
    super(code, message);
  }
}

const START = /<!-- generated: (.+?) -->/g;
const END = '<!-- /generated -->';

export interface BlockSpec {
  kind: string;
  args: string[];
}

export type Generator = (spec: BlockSpec) => string;

/** Regenerate blocks, using `where` as the filename in errors */
export function regenerate(markdown: string, generate: Generator, where: string): string {
  let out = '';
  let cursor = 0;
  for (const match of markdown.matchAll(START)) {
    const startIndex = match.index;
    if (startIndex < cursor) continue; // Skip markers inside replaced blocks
    const end = markdown.indexOf(END, startIndex);
    if (end === -1) {
      const line = lineOf(markdown, startIndex);
      throw new DocsError(
        'docs.unclosed-block',
        `${where}:${line}: Missing closing marker ${END} for \`${match[0]}\`.`,
        where,
        line,
      );
    }
    const [kind, ...args] = match[1].trim().split(/\s+/);
    let content: string;
    try {
      content = generate({ kind, args });
    } catch (error) {
      // Keep the error code and add the block location
      const message = error instanceof Error ? error.message : String(error);
      const line = lineOf(markdown, startIndex);
      throw new DocsError(
        error instanceof CodedError ? error.code : 'docs.generator-failed',
        `${where}:${line}: ${message}`,
        where,
        line,
      );
    }
    out +=
      markdown.slice(cursor, startIndex) +
      [
        match[0],
        '<!-- prettier-ignore-start -->',
        content,
        '<!-- prettier-ignore-end -->',
        END,
      ].join('\n');
    cursor = end + END.length;
  }
  return out + markdown.slice(cursor);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}
