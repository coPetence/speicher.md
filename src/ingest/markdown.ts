/**
 * Markdown-to-HTML pipeline with link resolution
 *
 * Parses markdown with callouts, wikilinks, footnotes, tasks, and optional MDX
 * Sanitizes output against an allowlist of tags, attributes, and URL schemes
 * Resolves internal links and remote images through caller-provided callbacks
 * Reports broken links and blocked images
 * Returns plain text and the first heading for indexing
 *
 * Also rewrites links in raw markdown source for agents to consume
 */

import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

import { CALLOUT_CLASS, CALLOUT_LABEL_CLASS, installCallouts } from './callouts';
import {
  FOOTNOTE_BACK_CLASS,
  FOOTNOTE_REF_CLASS,
  FOOTNOTES_CLASS,
  installFootnotes,
} from './footnotes';
import { CODE_TOKEN_PREFIX, highlightCode } from './highlight';
import {
  emptyMdxDropped,
  installMdx,
  MDX_ALLOWED_CLASSES,
  MdxEnv,
  TABS_SYNC_ATTR,
} from './mdx/mdx';
import { installTasks, TASK_CLASS, TASK_DONE_CLASS, TASK_STATE_CLASS } from './tasks';
import { installWikilinks, rewriteWikilinks, WIKILINK_ATTR, WIKILINK_EMBED } from './wikilinks';

/** Removes thead blocks whose inline cells are all empty */
function dropEmptyHeaderRow(state: MarkdownIt.StateCore): void {
  const tokens = state.tokens;

  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].type !== 'thead_open') continue;

    let close = i;
    while (close < tokens.length && tokens[close].type !== 'thead_close') close++;
    if (close === tokens.length) continue;

    const cells = tokens.slice(i, close).filter((token) => token.type === 'inline');
    if (cells.length === 0) continue;
    if (cells.some((cell) => cell.content.trim() !== '')) continue;

    tokens.splice(i, close - i + 1);
  }
}

/** Converts heading text to a URL-safe slug */
export function headingSlug(text: string): string {
  return text
    .replace(/[äöüÄÖÜß]/g, (c) => TRANSLITERATE[c] ?? c)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s/g, '-');
}

/** Strips the first h1 element from rendered HTML */
export function stripLeadingH1(html: string): string {
  return html.replace(/^\s*<h1\b[^>]*>[\s\S]*?<\/h1>\s*/, '');
}

/** German characters headingSlug replaces before slug generation */
const TRANSLITERATE: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  Ä: 'ae',
  Ö: 'oe',
  Ü: 'ue',
  ß: 'ss',
};

/** Render environment with heading deduplication state */
interface RenderEnv extends MdxEnv {
  headings: Map<string, number>;
}

/**
 * Assigns auto-generated IDs to headings
 *
 * Not on a heading that already has an id, to preserve manually set anchors
 * Duplicate slugs get a -n suffix for deduplication
 */
const renderHeadingOpen: MarkdownIt.Renderer.RenderRule = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const text = tokens[idx + 1]?.content ?? '';
  const base = headingSlug(text);
  if (base && !token.attrGet('id')) {
    const seen = (env as RenderEnv).headings;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    token.attrSet('id', count === 0 ? base : `${base}-${count}`);
  }
  return self.renderToken(tokens, idx, options);
};

/**
 * Creates a markdown-it instance with all plugins installed
 *
 * Installs callouts, wikilinks, footnotes, tasks, and conditionally MDX
 * Also adds the empty-thead removal rule and heading ID render rule
 */
function createParser(mdx: boolean): MarkdownIt {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: false,
    typographer: false,
    highlight: (code, language) => highlightCode(code, language) ?? '',
  });
  installCallouts(md);
  installWikilinks(md);
  installFootnotes(md);
  installTasks(md);
  if (mdx) installMdx(md);
  md.core.ruler.after('block', 'drop_empty_thead', dropEmptyHeaderRow);
  md.renderer.rules.heading_open = renderHeadingOpen;
  return md;
}

/** Parser for plain markdown (no MDX) */
const markdown = createParser(false);
/** Parser with MDX support */
const mdxMarkdown = createParser(true);

/** HTML tags allowed through the sanitizer */
export const ALLOWED_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'blockquote',
  'pre',
  'code',
  'em',
  'strong',
  'del',
  's',
  'ins',
  'sup',
  'sub',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'a',
  'img',
  'figure',
  'figcaption',
  'hr',
  'br',
  'span',
  'div',
  'section',
  'details',
  'summary',
  'abbr',
  'kbd',
  'samp',
  'var',
  'mark',
  'small',
  'time',
] as const;

/** Kind of link context for the resolveLink callback */
export type LinkKind = 'link' | 'wikilink' | 'wikiembed' | 'image';

/** Options for renderMarkdown */
export interface RenderOptions {
  resolveLink?: (target: string, kind: LinkKind) => string | null;
  resolveExternalImage?: (url: string) => string | null;
  /** Parse as MDX (`installMdx`). Decided by the file's extension, never its content. */
  mdx?: boolean;
}

export interface RenderResult {
  html: string;
  plain: string;
  firstHeading: string | null;
  brokenLinks: string[];
  blockedImages: string[];
  /** MDX components this renderer does not know, and expressions it could not run. */
  mdxComponents: string[];
  mdxExpressions: string[];
}

function alignFromStyle(tagName: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag {
  const match = /text-align:\s*(left|right|center|justify)/i.exec(attribs.style ?? '');
  const rest = { ...attribs };

  delete rest.style;
  return match
    ? { tagName, attribs: { ...rest, align: match[1].toLowerCase() } }
    : { tagName, attribs: rest };
}

/** Matches URLs with dangerous schemes (javascript, vbscript, data, file, blob) */
const DANGEROUS_URL = /^\s*(javascript|vbscript|data|file|blob)\s*:/i;

/** True if the URL does not use a dangerous scheme */
function isSafeUrl(url: string): boolean {
  return !DANGEROUS_URL.test(url);
}

/** True if the URL has a scheme or starts with // */
function isAbsolute(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');
}

/**
 * Parses markdown and returns sanitized HTML with link resolution
 *
 * Runs the source through markdown-it with all plugins, then sanitizes the
 * output, resolving internal links and proxying external images through
 * caller-provided callbacks
 *
 * Reports broken links and blocked images
 */
export function renderMarkdown(source: string, options: RenderOptions = {}): RenderResult {
  const brokenLinks: string[] = [];
  const blockedImages: string[] = [];

  const env: RenderEnv = { headings: new Map<string, number>(), mdx: emptyMdxDropped() };
  const rendered = (options.mdx ? mdxMarkdown : markdown).render(source, env);

  const html = sanitizeHtml(rendered, {
    allowedTags: [...ALLOWED_TAGS],
    allowedAttributes: {
      a: ['href', 'title', 'id', 'rel', 'target', 'data-broken', 'class', 'aria-label'],
      li: ['class'],
      ul: ['class'],
      sup: ['class'],
      section: ['class'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      span: ['data-broken-image', 'data-blocked-image', 'class'],
      code: ['class'],
      pre: ['class'],
      div: ['class', TABS_SYNC_ATTR],
      p: ['class'],
      h1: ['id'],
      h2: ['id'],
      h3: ['id'],
      h4: ['id'],
      h5: ['id'],
      h6: ['id'],
      th: ['colspan', 'rowspan', 'scope', 'align'],
      td: ['colspan', 'rowspan', 'align'],
      '*': ['id'],
    },
    allowedClasses: {
      span: [`${CODE_TOKEN_PREFIX}*`, TASK_STATE_CLASS, ...MDX_ALLOWED_CLASSES.span],
      li: [TASK_CLASS, TASK_DONE_CLASS, ...MDX_ALLOWED_CLASSES.li],
      sup: [FOOTNOTE_REF_CLASS],
      section: [FOOTNOTES_CLASS],
      code: ['language-*'],
      pre: ['language-*'],
      div: [CALLOUT_CLASS, `${CALLOUT_CLASS}-*`, ...MDX_ALLOWED_CLASSES.div],
      p: [CALLOUT_LABEL_CLASS, ...MDX_ALLOWED_CLASSES.p],
      ul: [...MDX_ALLOWED_CLASSES.ul],
      a: [FOOTNOTE_BACK_CLASS, ...MDX_ALLOWED_CLASSES.a],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    allowedStyles: {},
    transformTags: {
      th: alignFromStyle,
      td: alignFromStyle,
      // Drops dangerous URLs, secures external links, resolves internal ones
      a: (tagName, attribs): sanitizeHtml.Tag => {
        const { [WIKILINK_ATTR]: wikilink, ...rest } = attribs;
        const href = rest.href ?? '';
        const anchor = rest.id || rest.name;
        if (!href || !isSafeUrl(href)) {
          return { tagName: 'span', attribs: anchor ? { id: anchor } : {} };
        }
        if (isAbsolute(href) || href.startsWith('#')) {
          return href.startsWith('#')
            ? { tagName, attribs: rest }
            : { tagName, attribs: { ...rest, rel: 'noopener noreferrer nofollow' } };
        }

        const kind: LinkKind =
          wikilink === WIKILINK_EMBED ? 'wikiembed' : wikilink ? 'wikilink' : 'link';
        const resolved = options.resolveLink?.(href, kind) ?? null;
        if (resolved === null) {
          brokenLinks.push(href);
          return { tagName, attribs: { ...rest, href, 'data-broken': 'true' } };
        }
        return { tagName, attribs: { ...rest, href: resolved, ...(anchor ? { id: anchor } : {}) } };
      },
      // Drops dangerous images, proxies external ones, resolves internal ones
      img: (tagName, attribs): sanitizeHtml.Tag => {
        const rest = { ...attribs };
        delete rest[WIKILINK_ATTR];
        const src = rest.src ?? '';
        if (!src || !isSafeUrl(src)) return { tagName: 'span', attribs: {} };
        if (isAbsolute(src)) {
          const proxied = options.resolveExternalImage?.(src) ?? null;
          if (proxied === null) {
            blockedImages.push(src);
            return { tagName: 'span', attribs: { 'data-blocked-image': '1' } };
          }
          return { tagName, attribs: { ...rest, src: proxied, loading: 'lazy' } };
        }
        const resolved = options.resolveLink?.(src, 'image') ?? null;
        if (resolved === null) {
          brokenLinks.push(src);
          return { tagName: 'span', attribs: { 'data-broken-image': '1' } };
        }
        return { tagName, attribs: { ...rest, src: resolved, loading: 'lazy' } };
      },
    },
  });

  return {
    html,
    plain: htmlToPlainText(withoutFootnoteMarks(html)),
    firstHeading: firstH1(source),
    brokenLinks,
    blockedImages,
    mdxComponents: [...env.mdx.components],
    mdxExpressions: env.mdx.expressions,
  };
}

/**
 * Rewrites links in raw markdown source without rendering
 *
 * Skips content inside fenced code blocks
 * Rewrites inline links, reference definitions, and wikilinks
 * Leaves absolute URLs, fragments, and unsafe schemes unchanged
 */
export function rewriteMarkdownLinks(
  source: string,
  resolve: (target: string, kind: LinkKind) => string | null,
): string {
  const fence = /^([ \t]*)(```+|~~~+)/;
  const lines = source.split('\n');
  const out: string[] = [];
  let fenceMarker: string | null = null;

  for (const line of lines) {
    const match = fence.exec(line);
    if (fenceMarker !== null) {
      out.push(line);
      if (match && match[2].startsWith(fenceMarker)) fenceMarker = null;
      continue;
    }
    if (match) {
      fenceMarker = match[2];
      out.push(line);
      continue;
    }
    out.push(rewriteLineLinks(line, resolve));
  }
  return out.join('\n');
}

function rewriteLineLinks(
  line: string,
  resolve: (target: string, kind: LinkKind) => string | null,
): string {
  // Inline `[text](target)` and `![alt](target)`, plus reference definitions
  // `[id]: target`. Angle-bracketed and titled forms are handled by the capture.
  const inline = /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(\s+"[^"]*")?\s*\)/g;
  const reference = /^(\s*\[[^\]]+\]:\s*)<?([^\s>]+)>?(.*)$/;

  const rewritten = line.replace(inline, (whole, bang, text, target, title) => {
    const replacement = resolveTarget(target, bang === '!' ? 'image' : 'link', resolve);
    if (replacement === null) return whole;
    return `${bang}[${text}](${replacement}${title ?? ''})`;
  });

  const ref = reference.exec(rewritten);
  const withLinks = (() => {
    // `[^1]: the note` is a footnote, whose text would otherwise be resolved as a
    // link target and rewritten into a URL.
    if (!ref || /^\s*\[\^/.test(ref[1])) return rewritten;
    const replacement = resolveTarget(ref[2], 'link', resolve);
    return replacement === null ? rewritten : `${ref[1]}${replacement}${ref[3]}`;
  })();

  return rewriteWikilinks(withLinks, (target, kind) =>
    // `[[#section]]` is an in-page link and already says where it goes.
    target.startsWith('#') ? target : resolveTarget(target, kind, resolve),
  );
}

function resolveTarget(
  target: string,
  kind: LinkKind,
  resolve: (target: string, kind: LinkKind) => string | null,
): string | null {
  if (!target || target.startsWith('#') || isAbsolute(target)) return null;
  if (!isSafeUrl(target)) return null;
  return resolve(target, kind);
}

function withoutFootnoteMarks(html: string): string {
  return html
    .replace(new RegExp(`<sup class="${FOOTNOTE_REF_CLASS}">[\\s\\S]*?</sup>`, 'g'), '')
    .replace(new RegExp(` ?<a [^>]*class="${FOOTNOTE_BACK_CLASS}"[^>]*>[\\s\\S]*?</a>`, 'g'), '');
}

export function htmlToPlainText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstH1(source: string): string | null {
  for (const line of source.split('\n')) {
    const atx = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) return stripInlineMarkup(atx[1]);
  }

  const lines = source.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (/^=+\s*$/.test(lines[i]) && lines[i - 1].trim().length > 0) {
      return stripInlineMarkup(lines[i - 1].trim());
    }
  }
  return null;
}

function stripInlineMarkup(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/_([^_]*)_/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}
