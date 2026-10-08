/**
 * Inline help-rendering for admin config forms
 *
 * Converts a markdown-like syntax to HTML using only inline elements: code spans,
 * links, bold, underline. Block-level constructs are not handled
 *
 * The syntax is a subset of Markdown that avoids ambiguity:
 *  backtick code, `[text](url)` link, `**bold**`, `_underline_`
 *
 * Not using a full Markdown parser to keep the bundle small and avoid
 * rendering block elements in a single-line context
 */

import { renderInlineIcon } from '../../../content-reader/icons';
import { escapeHtml } from '../../../content-reader/views';

// Group 1: code  | Group 2-3: link text, URL  | Group 4: bold  | Group 5: underline
const INLINE =
  /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(\S(?:[^*]*\S)?)\*\*|(?<!\w)_(\S(?:[^_]*\S)?)_(?!\w)/g;

export function renderHelp(text: string): string {
  return escapeHtml(text).replace(
    INLINE,
    (
      match,
      code?: string,
      linkText?: string,
      linkHref?: string,
      bold?: string,
      underline?: string,
    ) => {
      if (code !== undefined) return `<code>${code}</code>`;
      if (linkText !== undefined && linkHref !== undefined) return anchor(linkText, linkHref);
      if (bold !== undefined) return `<strong>${bold}</strong>`;
      if (underline !== undefined) return `<u>${underline}</u>`;
      return match;
    },
  );
}

function anchor(text: string, href: string): string {
  const target = hrefOf(href);
  if (target === null) return text;

  // Relative: same window; external: new tab with security attributes
  if (target.startsWith('/')) return `<a href="${target}">${text}</a>`;
  return (
    `<a href="${target}" target="_blank" rel="noopener noreferrer nofollow">${text}` +
    `${externalMark()}<span class="spr-clipped"> (external link)</span></a>`
  );
}

let mark: string | null = null;

function externalMark(): string {
  mark ??= renderInlineIcon('external-link', 'spr-external');
  return mark;
}

function hrefOf(href: string): string | null {
  // Allow only absolute paths and https; reject protocol-relative (//)
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  if (href.startsWith('https://')) return href;
  return null;
}
