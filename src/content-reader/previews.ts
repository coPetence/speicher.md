import { escapeHtml } from './views';

export interface LinkPreview {
  href: string;
  title: string;
  description: string | null;
}

export const PREVIEW_ATTRIBUTE = 'data-spr-preview';

const MAX_PREVIEW = 180;

/**
 * Annotate links with a preview attribute where a match exists
 *
 * Matching links get `data-spr-preview` with a summary of the destination
 * minus the link text; links already carrying the attribute are unchanged
 */
export function annotateLinkPreviews(html: string, previews: LinkPreview[]): string {
  if (previews.length === 0) return html;

  const byHref = new Map<string, LinkPreview>();
  for (const preview of previews) byHref.set(normalizeHref(preview.href), preview);

  // Matches <a> tags and extracts:
  //  pre-href attributes (Group 1),
  //  href URL (Group 2),
  //  post-href attributes (Group 3),
  //  and inner HTML content (Group 4).
  return html.replace(
    /<a\s([^>]*?)href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi,
    (element, before, href, after, inner) => {
      if (element.includes(PREVIEW_ATTRIBUTE)) return element;
      const preview = byHref.get(normalizeHref(href));
      if (!preview) return element;
      const summary = summarize(preview, textOf(inner));
      if (summary === null) return element;
      const open = `<a ${before}href="${href}"${after} ${PREVIEW_ATTRIBUTE}="${escapeHtml(summary)}">`;
      return `${open}${inner}</a>`;
    },
  );
}

/**
 * Build a preview string from link metadata, excluding the link text
 *
 * Returns null when no new content remains after removing the link text
 */
function summarize(preview: LinkPreview, linkText: string): string | null {
  const said = fold(linkText);
  const parts = [preview.title, preview.description ?? '']
    .map((part) => part.trim())
    .filter((part) => part !== '' && !said.includes(fold(part)));
  if (parts.length === 0) return null;
  return truncate(parts.join(' — '), MAX_PREVIEW);
}

/** Strip HTML tags and expand named entities to their characters */
function textOf(inner: string): string {
  return (
    inner
      .replace(/<[^>]*>/g, ' ')
      // Matches named HTML entities and captures the entity name (Group 1)
      .replace(
        /&(nbsp|amp|lt|gt|quot|#39|#x27);/g,
        (_, name: string) =>
          ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[name] ??
          ' ',
      )
  );
}

/** Lowercase and collapse non-alphanumeric runs to single spaces */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Truncate text at a word boundary near the limit
 *
 * Uses the last space before the cut when it lies past the halfway point
 * Otherwise cuts at the hard limit.  Appends an ellipsis.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > max / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** Strip fragment and query; keep root path, remove trailing slashes otherwise */
function normalizeHref(href: string): string {
  const path = href.split('#')[0].split('?')[0];
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}
