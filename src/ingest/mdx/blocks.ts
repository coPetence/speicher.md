import MarkdownIt from 'markdown-it';

import { MdxEnv, recordExpression } from './env';
import { JsxTag, parseTag, scanExpression } from './jsx';

/**
 * Block-level MDX parsing rules
 *
 * Three block rules for markdown-it: JSX tags, ESM import/export statements,
 * and brace expressions
 * Each follows the RuleBlock convention: return false if not matched, true if
 * matched
 * A silent call only checks whether the rule could match, without emitting
 * tokens
 */
function lineStart(state: MarkdownIt.StateBlock, line: number): number {
  return state.bMarks[line] + state.tShift[line];
}

/**
 * Parse consecutive JSX tags starting from a line
 *
 * Multiple tags on one line are only accepted if all are void
 * Returns null if the line does not start with a valid JSX tag
 */
function lineTags(
  state: MarkdownIt.StateBlock,
  startLine: number,
  endLine: number,
): { tags: JsxTag[]; lastLine: number } | null {
  const src = state.src;
  const max = state.eMarks[endLine - 1];
  let pos = lineStart(state, startLine);
  const tags: JsxTag[] = [];
  for (;;) {
    const tag = parseTag(src, pos, max);
    if (!tag) return null;
    tags.push(tag);
    pos = tag.end;
    while (pos < max && (src[pos] === ' ' || src[pos] === '\t')) pos++;
    if (pos >= max || src[pos] === '\n') break;
    if (src[pos] !== '<') return null;
  }
  if (tags.length > 1 && tags.some((tag) => tag.kind !== 'void')) return null;

  let lastLine = startLine;
  while (lastLine < endLine - 1 && state.eMarks[lastLine] < pos) lastLine++;
  return { tags, lastLine };
}

/**
 * Matches code fence markers
 *
 * Captures the fence character sequence (backticks or tildes, three or more)
 */
const FENCE = /^(`{3,}|~{3,})/;

/**
 * Find the matching close tag for a named JSX element
 *
 * Tracks nesting depth and skips over fenced code blocks
 * Returns the line number of the match, or -1 if not found
 */
function findClose(
  state: MarkdownIt.StateBlock,
  name: string,
  from: number,
  endLine: number,
): number {
  let depth = 1;
  let fence: string | null = null;
  for (let line = from; line < endLine; line++) {
    const text = state.src.slice(lineStart(state, line), state.eMarks[line]);
    // Skip lines inside a fenced code block to avoid parsing `<` as a tag
    const marker = FENCE.exec(text);
    if (fence !== null) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    if (!text.startsWith('<')) continue;
    const found = lineTags(state, line, line + 1);
    if (!found || found.tags.length !== 1 || found.tags[0].name !== name) continue;
    if (found.tags[0].kind === 'open') depth++;
    else if (found.tags[0].kind === 'close' && --depth === 0) return line;
  }
  return -1;
}

/**
 * Block-level JSX tag parsing
 *
 * An open tag starts a block that finds its matching close and tokenizes
 * inner content as markdown with adjusted indentation
 * Void tags on their own line emit individual tokens
 * A close tag on its own line produces no block token
 * An open tag without a matching close is silently consumed
 */
export const jsxBlock: MarkdownIt.ParserBlock.RuleBlock = (state, startLine, endLine, silent) => {
  if (state.src[lineStart(state, startLine)] !== '<') return false;
  const found = lineTags(state, startLine, endLine);
  if (!found) return false;
  if (silent) return true;

  const { tags, lastLine } = found;
  const [first] = tags;

  if (first.kind !== 'open') {
    // Emit tokens for void tags; close tags produce no block output
    for (const tag of tags) {
      if (tag.kind !== 'void') continue;
      const token = state.push('mdx_jsx_void', '', 0);
      token.meta = tag;
      token.block = true;
      token.map = [startLine, lastLine + 1];
    }
    state.line = lastLine + 1;
    return true;
  }

  const close = findClose(state, first.name, lastLine + 1, endLine);
  if (close < 0) {
    // No matching close tag: advance past the opening line without emitting
    state.line = lastLine + 1;
    return true;
  }

  const open = state.push('mdx_jsx_open', '', 1);
  open.meta = first;
  open.block = true;
  open.map = [startLine, close + 1];

  // Find the minimum indentation inside the block for tokenizing inner content
  let indent = Infinity;
  for (let line = lastLine + 1; line < close; line++) {
    if (!state.isEmpty(line)) indent = Math.min(indent, state.sCount[line]);
  }

  const oldParent = state.parentType;
  const oldLineMax = state.lineMax;
  const oldIndent = state.blkIndent;
  // Tokenize inner content as markdown, bounded by the close line and with
  // the inner indent as base
  state.parentType = 'mdx' as MarkdownIt.StateBlock.ParentType;
  state.lineMax = close;
  state.blkIndent = Number.isFinite(indent) ? Math.max(oldIndent, indent) : oldIndent;
  state.md.block.tokenize(state, lastLine + 1, close);
  state.parentType = oldParent;
  state.lineMax = oldLineMax;
  state.blkIndent = oldIndent;

  const closing = state.push('mdx_jsx_close', '', -1);
  closing.meta = first;
  closing.block = true;
  state.line = close + 1;
  return true;
};

/**
 * ESM import/export statements at the top level of an MDX file
 *
 * Only matches at root level with no indentation
 * Consumes all subsequent non-empty lines as part of the statement
 */
export const esmBlock: MarkdownIt.ParserBlock.RuleBlock = (state, startLine, endLine, silent) => {
  if (state.parentType !== 'root' || state.sCount[startLine] !== 0) return false;
  const text = state.src.slice(lineStart(state, startLine), state.eMarks[startLine]);
  if (!/^(import|export)[\s{*]/.test(text)) return false;
  if (silent) return true;

  let line = startLine + 1;
  while (line < endLine && !state.isEmpty(line)) line++;
  state.line = line;
  return true;
};

/**
 * Block-level brace expressions in MDX
 *
 * An expression must be the only content on its line
 * Records the expression in the env via recordExpression
 */
export const expressionBlock: MarkdownIt.ParserBlock.RuleBlock = (
  state,
  startLine,
  endLine,
  silent,
) => {
  const start = lineStart(state, startLine);
  if (state.src[start] !== '{') return false;
  const max = state.eMarks[endLine - 1];
  const end = scanExpression(state.src, start, max);
  if (end < 0) return false;

  let pos = end;
  while (pos < max && (state.src[pos] === ' ' || state.src[pos] === '\t')) pos++;
  if (pos < max && state.src[pos] !== '\n') return false;
  if (silent) return true;

  recordExpression(state.env as MdxEnv, state.src.slice(start, end));
  let line = startLine;
  while (line < endLine - 1 && state.eMarks[line] < pos) line++;
  state.line = line + 1;
  return true;
};
