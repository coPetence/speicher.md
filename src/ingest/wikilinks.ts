/**
 * Wikilink syntax for markdown-it
 *
 * Parses `[[target]]` as a plain wikilink and `![[target]]` as an embed
 * in two modes: a markdown-it inline rule for full parsing, and a
 * raw-line replacer for the rewrite path
 *
 * All wikilinks are tagged with `data-spr-wikilink` so the renderer
 * can route them through vault-aware resolution
 */

import MarkdownIt from 'markdown-it';
import type { LinkResolution } from './markdown';
import { isMarkdown } from './paths';

/** HTML attribute identifying links that came from wikilink syntax */
export const WIKILINK_ATTR = 'data-spr-wikilink';

/** Value for a plain wikilink (rendered as a link) */
export const WIKILINK_LINK = 'link';

/** Value for an embed wikilink (rendered as an iframe or object) */
export const WIKILINK_EMBED = 'embed';

export const WIKILINK_TITLE_ATTR = 'data-spr-wikilink-title';

/** Newline and `[` forbidden: newline crosses line boundary, `[` would
 *  allow ambiguous `[[` nesting */
const FORBIDDEN_IN_TARGET = /[\n[]/;

/** markdown-it inline rule for `[[target]]` and `![[target]]`
 *
 * Embeddable files produce an `<img>`; other embeds produce a link
 * with `WIKILINK_EMBED`; plain wikilinks get `WIKILINK_LINK`
 *
 * Not `[` inside target to avoid ambiguous nesting */
function wikilinkRule(state: MarkdownIt.StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;

  const embed = src.charCodeAt(start) === 0x21;
  const open = embed ? start + 1 : start;
  if (src.charCodeAt(open) !== 0x5b || src.charCodeAt(open + 1) !== 0x5b) return false;

  const contentStart = open + 2;
  const close = src.indexOf(']]', contentStart);
  if (close === -1 || close > state.posMax) return false;

  const inner = src.slice(contentStart, close);
  if (inner === '' || FORBIDDEN_IN_TARGET.test(inner)) return false;

  const { target, alias } = splitInner(inner);
  if (target === '') return false;

  const label = alias ?? target;

  if (!silent) {
    if (embed && isEmbeddableFile(target)) {
      const token = state.push('image', 'img', 0);
      token.attrs = [
        ['src', target],
        ['alt', ''],
        [WIKILINK_ATTR, WIKILINK_LINK],
      ];

      const alt = new state.Token('text', '', 0);
      alt.content = alias ?? '';
      token.children = [alt];
      token.content = alt.content;
    } else {
      const openToken = state.push('link_open', 'a', 1);
      openToken.attrs = [
        ['href', target],
        [WIKILINK_ATTR, embed ? WIKILINK_EMBED : WIKILINK_LINK],
        ...(alias === null ? [[WIKILINK_TITLE_ATTR, 'page'] as [string, string]] : []),
      ];
      const text = state.push('text', '', 0);
      text.content = label;
      state.push('link_close', 'a', -1);
    }
  }

  state.pos = close + 2;
  return true;
}

/** Register wikilink rule before standard link rule so `[[` is consumed first */
export function installWikilinks(md: MarkdownIt): void {
  md.inline.ruler.before('link', 'wikilink', wikilinkRule);
}

/** Replace `[[wikilinks]]` with standard markdown syntax
 *
 * Embeddable embeds become `![target](href)` (kind image)
 * Other embeds become `[target](href)` (kind wikiembed)
 * Plain wikilinks become `[target](href)` (kind wikilink)
 * Links without an alias show the linked page's title
 * Left unchanged when resolver returns null */
export function rewriteWikilinks(
  line: string,
  resolve: (target: string, kind: 'wikilink' | 'wikiembed' | 'image') => LinkResolution,
): string {
  // Matches [[target]] and ![[target]]:
  //  Group 1: optional `!` for embeds
  //  Group 2: inner content (no newlines or brackets)
  return line.replace(/(!?)\[\[([^\n[\]]+)\]\]/g, (whole, bang: string, inner: string) => {
    const { target, alias } = splitInner(inner);
    if (target === '') return whole;
    const asImage = bang === '!' && isEmbeddableFile(target);
    const resolved = resolve(target, asImage ? 'image' : bang === '!' ? 'wikiembed' : 'wikilink');
    if (resolved === null) return whole;
    if (typeof resolved === 'string') {
      return `${asImage ? '!' : ''}[${alias ?? (asImage ? '' : target)}](${resolved})`;
    }
    return `[${alias ?? escapeBrackets(resolved.title)}](${resolved.href})`;
  });
}

function escapeBrackets(text: string): string {
  return text.replace(/[[\]\\]/g, '\\$&');
}

/** Split `target|alias` at the first pipe, trimming both parts */
function splitInner(inner: string): { target: string; alias: string | null } {
  const pipe = inner.indexOf('|');
  if (pipe === -1) return { target: inner.trim(), alias: null };
  const alias = inner.slice(pipe + 1).trim();
  return { target: inner.slice(0, pipe).trim(), alias: alias === '' ? null : alias };
}

/** True for non-markdown files with a file extension */
export function isEmbeddableFile(target: string): boolean {
  return !isMarkdown(target) && /\.[A-Za-z0-9]+$/.test(target);
}
