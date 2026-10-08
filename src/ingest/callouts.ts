/**
 * Callout boxes via `:::` directives and GitHub blockquote alerts
 *
 * Both produce a `<div class="spr-callout spr-callout-{level}">` wrapping a
 * `<p class="spr-callout-label">` heading and the body content
 *
 * `:::` syntax is handled by the markdown-it-container plugin
 * `> [!ALERT]` syntax is handled by a core rule that rewrites blockquote tokens
 *
 * The two syntaxes map `caution` differently, matching each ecosystem's convention:
 * `:::caution` is warning, `[!CAUTION]` is danger
 */

import MarkdownIt from 'markdown-it';
import container from 'markdown-it-container';

export const CALLOUT_LEVELS = ['note', 'info', 'tip', 'important', 'warning', 'danger'] as const;

export type CalloutLevel = (typeof CALLOUT_LEVELS)[number];

export const CALLOUT_CLASS = 'spr-callout';
export const CALLOUT_LABEL_CLASS = 'spr-callout-label';

// Directive names to callout levels — `caution` is treated as warning (its value in the
// admonition ecosystem)
const DIRECTIVE_LEVELS: Record<string, CalloutLevel> = {
  note: 'note',
  info: 'info',
  tip: 'tip',
  important: 'important',
  warning: 'warning',
  caution: 'warning',
  danger: 'danger',
};

// GitHub alert names to callout levels — `CAUTION` is treated as danger (its value in
// the GitHub-flavoured markdown ecosystem)
const ALERT_LEVELS: Record<string, CalloutLevel> = {
  NOTE: 'note',
  TIP: 'tip',
  IMPORTANT: 'important',
  WARNING: 'warning',
  CAUTION: 'danger',
};

interface Callout {
  level: CalloutLevel;

  label: string;

  title: string | null;
}

// Matches `:name` or `:name[title]` or `:name title`
// Group 1: directive name, Group 2: title in brackets, Group 3: title after space
function parseDirective(params: string): Callout | null {
  const match = /^([a-z]+)[ \t]*(?:\[([^\]]*)\]|(.*))?$/i.exec(params.trim());
  if (!match) return null;

  const name = match[1].toLowerCase();
  const level = DIRECTIVE_LEVELS[name];
  if (!level) return null;

  const title = (match[2] ?? match[3] ?? '').trim();
  return { level, label: capitalise(name), title: title || null };
}

export function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function openTag(callout: Callout, md: MarkdownIt, env: unknown): string {
  const heading = callout.title
    ? md.renderInline(callout.title, env)
    : md.utils.escapeHtml(callout.label);

  return calloutOpenTag(callout.level, heading);
}

export function calloutOpenTag(level: CalloutLevel, headingHtml: string): string {
  return (
    `<div class="${CALLOUT_CLASS} ${CALLOUT_CLASS}-${level}">` +
    `<p class="${CALLOUT_LABEL_CLASS}">${headingHtml}</p>\n`
  );
}

export function directiveLevel(name: string): CalloutLevel | null {
  return DIRECTIVE_LEVELS[name.toLowerCase()] ?? null;
}

export const CALLOUT_CLOSE_TAG = '</div>\n';

const OPEN = 'callout_open';
const CLOSE = 'callout_close';

// Rewrites blockquote tokens whose first paragraph starts with `[!ALERT]`
// into callout tokens so the renderer produces a callout box instead of a blockquote
function alertRule(state: MarkdownIt.StateCore): void {
  const tokens = state.tokens;

  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i].type !== 'blockquote_open') continue;
    if (tokens[i + 1].type !== 'paragraph_open') continue;

    const inline = tokens[i + 2];
    if (inline.type !== 'inline') continue;

    const marker = /^\[!([A-Za-z]+)\][ \t]*(?:\n|$)/.exec(inline.content);
    if (!marker) continue;

    const level = ALERT_LEVELS[marker[1].toUpperCase()];
    if (!level) continue;

    const close = matchingClose(tokens, i);
    if (close < 0) continue;

    tokens[i].type = OPEN;
    tokens[i].meta = { level, label: capitalise(marker[1]), title: null } satisfies Callout;
    tokens[close].type = CLOSE;

    const body = inline.content.slice(marker[0].length);
    if (body.trim() === '') {
      // Nothing remains in the paragraph — remove the paragraph_open, inline, paragraph_close
      // tokens so we do not emit an empty `<p></p>`
      tokens.splice(i + 1, 3);
    } else {
      inline.content = body;
    }
  }
}

// Walks forward from a blockquote_open to find its matching blockquote_close, counting
// nested blockquotes
function matchingClose(tokens: MarkdownIt.Token[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].type === 'blockquote_open') depth++;
    else if (tokens[i].type === 'blockquote_close') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function installCallouts(md: MarkdownIt): void {
  const renderDirective: MarkdownIt.Renderer.RenderRule = (tokens, idx, _options, env) => {
    if (tokens[idx].nesting !== 1) return CALLOUT_CLOSE_TAG;
    const callout = parseDirective(tokens[idx].info);

    return callout ? openTag(callout, md, env) : '';
  };

  // Registers a container that matches any `:::` block whose params describe a known
  // callout level, leaving unrecognised directives as raw text
  md.use(container, 'callout', {
    validate: (params: string) => parseDirective(params) !== null,
    render: renderDirective,
  });

  md.core.ruler.after('block', 'github_alerts', alertRule);

  // Render rules for the synthetic OPEN/CLOSE token types produced by alertRule
  md.renderer.rules[OPEN] = (tokens, idx, _options, env) =>
    openTag(tokens[idx].meta as Callout, md, env);
  md.renderer.rules[CLOSE] = () => CALLOUT_CLOSE_TAG;
}
