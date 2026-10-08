/**
 * The block of a page a search hit landed in, drawn as the page draws it
 *
 * A snippet is text: `ts_headline` works on `documents.plain`, so a hit inside a
 * code block arrives as the code's words with the formatting gone. What a reader
 * wants to see is the block itself — the paragraph, the list item, the fenced
 * code — with the words they searched for marked in it. The stored HTML is the
 * page's own, sanitised at ingest, so cutting one block out of it and drawing it
 * is exactly as safe as drawing the page
 *
 * The web page is the only consumer. The MCP tool keeps the plain `snippet`: an
 * agent quotes text, and a `<pre>` with highlighting classes in it is not a
 * passage
 */

import { ElementType, parseDocument } from 'htmlparser2';
import type { ChildNode, Element, Text } from 'domhandler';

/**
 * Where a hit can land: the innermost of these holding a term is the excerpt.
 *
 * A table is the block, not its cell: a cell is a value whose meaning is its row
 * and its column heading, and `1,850` on its own is a number with nothing to say
 * what it is the price of. The budget cuts a long table as it cuts a long code
 * block, with the heading row first.
 */
const BLOCKS = new Set([
  'p',
  'li',
  'pre',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'dt',
  'dd',
  'figcaption',
]);

/**
 * A block that only makes sense inside its parent is drawn as a plain division:
 * a bare `<li>` outside a list is markup the browser repairs on its own terms,
 * and a heading inside a card is a second title
 */
const AS_DIV: Record<string, string> = {
  li: 'div',
  dt: 'div',
  dd: 'div',
  h1: 'p',
  h2: 'p',
  h3: 'p',
  h4: 'p',
  h5: 'p',
  h6: 'p',
};

const VOID = new Set(['br', 'hr', 'wbr']);

/**
 * Not drawn in an excerpt. A link is unwrapped to its text: the card is one
 * target already, its stretched link covers everything in it, and an `href` to a
 * page the reader cannot open would name that page on a results page that has
 * only ever named what the reader may read — the page itself draws such a link,
 * but a results page is read by people looking for exactly that. A picture is
 * dropped: a card is a way of choosing, not the page
 */
const UNWRAPPED = new Set(['a']);
const DROPPED = new Set(['img', 'picture', 'svg', 'video', 'audio']);

/** Text the excerpt may carry before it is cut; a fenced file is not a preview */
const TEXT_BUDGET = 1_200;

/**
 * The words a query asks for, as the things to mark
 *
 * `websearch_to_tsquery` syntax: a quoted phrase is one term, `-word` excludes and
 * is not something to mark, `or` is an operator. One character is noise
 */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (const match of query.matchAll(re)) {
    const raw = (match[1] ?? match[2]).trim();
    if (raw === '' || raw.startsWith('-') || raw.toLowerCase() === 'or') continue;
    const term = raw.replace(/^["']+|["']+$/g, '').toLowerCase();
    if (term.length >= 2 && !terms.includes(term)) terms.push(term);
  }
  // Longest first, so `rate card` is marked whole before `rate` is
  return terms.sort((a, b) => b.length - a.length);
}

export interface Excerpt {
  /** The block, marked, as safe HTML */
  html: string;
  /**
   * The text directive that lands a reader on the marked words when the page
   * opens — `:~:text=…`, one `text=` per term found — or `''` when none was.
   *
   * A fragment and not a query parameter, deliberately. The server never sees it,
   * so the page's response is the same bytes for every reader who arrives from a
   * search: still compressed, still a public page a cache may hold, still not
   * metered as caller input. The browser does the scrolling and the highlighting
   * itself; a browser without the feature lands at the top and reads the page
   */
  fragment: string;
}

/**
 * The innermost block of `html` containing one of `terms`, with the terms
 * marked, or null when no block holds one — a stemmed or fuzzy match the page
 * spells differently, which the plain snippet still shows
 */
export function excerptOf(html: string, terms: string[]): Excerpt | null {
  if (terms.length === 0) return null;
  const root = parseDocument(html);
  const block = findBlock(root.children, terms);
  if (!block) return null;

  const matcher = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
  const out: string[] = [];
  const budget = { left: TEXT_BUDGET, cut: false };
  const directives = new Map<string, string>();
  serialise(block, matcher, out, budget, true, directives);
  const fragment =
    directives.size === 0 ? '' : `:~:text=${[...directives.values()].join('&text=')}`;
  return { html: out.join(''), fragment };
}

/** Words of context either side of a match, so the directive lands on *this* one */
const CONTEXT_WORDS = 3;

/**
 * One text directive for a match: `prefix-,term,-suffix`, with the context taken
 * from the same text node so it is adjacent, which is what the syntax requires.
 * Every piece is percent-encoded, and the three characters the syntax itself
 * uses are encoded too, since `encodeURIComponent` leaves a hyphen alone
 */
function directiveFor(text: string, start: number, end: number): string {
  const before = text.slice(0, start).trim().split(/\s+/).filter(Boolean).slice(-CONTEXT_WORDS);
  const after = text.slice(end).trim().split(/\s+/).filter(Boolean).slice(0, CONTEXT_WORDS);
  const piece = (value: string) =>
    encodeURIComponent(value).replace(/-/g, '%2D').replace(/,/g, '%2C').replace(/&/g, '%26');
  const parts: string[] = [];
  if (before.length > 0) parts.push(`${piece(before.join(' '))}-`);
  parts.push(piece(text.slice(start, end)));
  if (after.length > 0) parts.push(`-${piece(after.join(' '))}`);
  return parts.join(',');
}

function findBlock(nodes: ChildNode[], terms: string[]): Element | null {
  for (const node of nodes) {
    if (node.type !== ElementType.Tag) continue;
    const element = node as Element;
    if (BLOCKS.has(element.name) && containsTerm(textOf(element), terms)) {
      // Descend while a child block also holds a term: a list item's paragraph
      // over the list item, a table cell over the row
      return findBlock(element.children, terms) ?? element;
    }
    const inner = findBlock(element.children, terms);
    if (inner) return inner;
  }
  return null;
}

function containsTerm(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function textOf(node: ChildNode): string {
  if (node.type === ElementType.Text) return (node as Text).data;
  if (node.type === ElementType.Tag) return (node as Element).children.map(textOf).join('');
  return '';
}

/**
 * Written back out by hand rather than through a serialiser: the input is this
 * renderer's own sanitised output, so the element set is closed, and writing it
 * is what lets the marks go in and the budget be kept with the tags still
 * balanced
 */
function serialise(
  node: ChildNode,
  matcher: RegExp,
  out: string[],
  budget: { left: number; cut: boolean },
  top: boolean,
  directives: Map<string, string>,
): void {
  if (budget.cut) return;
  if (node.type === ElementType.Text) {
    let text = (node as Text).data;
    if (text.length > budget.left) {
      text = `${text.slice(0, budget.left)}…`;
      budget.cut = true;
    }
    budget.left -= text.length;
    out.push(mark(text, matcher, directives));
    return;
  }
  if (node.type !== ElementType.Tag) return;

  const element = node as Element;
  if (DROPPED.has(element.name)) return;
  if (UNWRAPPED.has(element.name)) {
    for (const child of element.children) serialise(child, matcher, out, budget, false, directives);
    return;
  }
  const name = top ? (AS_DIV[element.name] ?? element.name) : element.name;
  const attributes = Object.entries(element.attribs)
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join('');
  if (VOID.has(name)) {
    out.push(`<${name}${attributes}>`);
    return;
  }
  out.push(`<${name}${attributes}>`);
  for (const child of element.children) serialise(child, matcher, out, budget, false, directives);
  out.push(`</${name}>`);
}

/**
 * Escapes the text and wraps each term in `<mark>`, in text nodes only — and
 * records a directive for the first place each term was found
 */
function mark(text: string, matcher: RegExp, directives: Map<string, string>): string {
  let result = '';
  let last = 0;
  for (const match of text.matchAll(matcher)) {
    const term = match[0].toLowerCase();
    if (!directives.has(term)) {
      directives.set(term, directiveFor(text, match.index, match.index + match[0].length));
    }
    result += escapeText(text.slice(last, match.index));
    result += `<mark>${escapeText(match[0])}</mark>`;
    last = match.index + match[0].length;
  }
  return result + escapeText(text.slice(last));
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
