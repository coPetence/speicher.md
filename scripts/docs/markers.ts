/**
 * Generated blocks in the docs
 *
 * A block is fenced by two comments, and everything between them belongs to the
 * generator:
 *
 *   <!-- generated: schema instance#/properties/mail -->
 *   …
 *   <!-- /generated -->
 *
 * The text after `generated:` is the kind, then its arguments, split on whitespace.
 * The content is wrapped in prettier-ignore so a repo-wide format cannot reflow a
 * table the generator will only rewrite again.
 */

const START = /<!-- generated: (.+?) -->/g;
const END = '<!-- /generated -->';

export interface BlockSpec {
  kind: string;
  args: string[];
}

export type Generator = (spec: BlockSpec) => string;

/** Rewrites every generated block in `markdown`; `where` names the file in errors */
export function regenerate(markdown: string, generate: Generator, where: string): string {
  let out = '';
  let cursor = 0;
  for (const match of markdown.matchAll(START)) {
    const startIndex = match.index;
    if (startIndex < cursor) continue; // A start comment inside a block being replaced
    const end = markdown.indexOf(END, startIndex);
    if (end === -1) {
      throw new Error(`${where}:${lineOf(markdown, startIndex)}: \`${match[0]}\` has no ${END}`);
    }
    const [kind, ...args] = match[1].trim().split(/\s+/);
    let content: string;
    try {
      content = generate({ kind, args });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${where}:${lineOf(markdown, startIndex)}: ${message}`);
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
