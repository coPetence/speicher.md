/**
 * Inline rules for MDX
 *
 * JSX tags and brace expressions are parsed as inline tokens
 */

import MarkdownIt from 'markdown-it';

import { MdxEnv, recordExpression } from './env';
import { parseTag, scanExpression } from './jsx';

/**
 * Markdown-it inline rule for JSX tags
 *
 * Unpaired tags emitted as plain text to avoid broken component output
 */
export function jsxInline(state: MarkdownIt.StateInline, silent: boolean): boolean {
  if (state.src[state.pos] !== '<') return false;
  const tag = parseTag(state.src, state.pos, state.posMax);
  if (!tag) return false;

  const unpaired =
    (tag.kind === 'open' && state.src.indexOf(`</${tag.name}>`, tag.end) < 0) ||
    (tag.kind === 'close' && state.src.lastIndexOf(`<${tag.name}`, state.pos) < 0);
  if (unpaired) {
    if (!silent) state.push('text', '', 0).content = state.src.slice(state.pos, tag.end);
  } else if (!silent) {
    const token = state.push('mdx_jsx_inline', '', 0);
    token.meta = tag;
  }
  state.pos = tag.end;
  return true;
}

/** Markdown-it inline rule for brace expressions */
export function expressionInline(state: MarkdownIt.StateInline, silent: boolean): boolean {
  if (state.src[state.pos] !== '{') return false;
  const end = scanExpression(state.src, state.pos, state.posMax);
  if (end < 0) return false;
  if (!silent) recordExpression(state.env as MdxEnv, state.src.slice(state.pos, end));
  state.pos = end;
  return true;
}

/**
 * Strips JSX and expressions from heading content
 *
 * Content stripped to avoid JSX markup in anchor IDs
 */
export function headingText(state: MarkdownIt.StateCore): void {
  const tokens = state.tokens;
  for (let i = 1; i < tokens.length; i++) {
    const inline = tokens[i];
    if (tokens[i - 1].type !== 'heading_open' || inline.type !== 'inline') continue;
    if (!inline.children?.some((child) => child.type === 'mdx_jsx_inline')) continue;
    inline.content = withoutJsx(inline.content);
  }
}

/** Strips JSX tags and brace expressions from a string */
function withoutJsx(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const end =
      text[i] === '<'
        ? (parseTag(text, i, text.length)?.end ?? -1)
        : text[i] === '{'
          ? scanExpression(text, i, text.length)
          : -1;
    if (end > i) {
      i = end;
    } else {
      out += text[i];
      i++;
    }
  }
  return out.trim();
}
