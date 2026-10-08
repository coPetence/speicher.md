/**
 * Syntax highlighting for code fences
 *
 * Wraps highlight.js to produce highlighted HTML for the markdown pipeline
 * Maps highlight.js scope names to custom token classes
 * Registers eight languages not included in highlight.js's common set
 *
 * Returns null when the language is unknown, the code is too large, or
 * highlight itself throws, leaving the fence unhighlighted
 */

import hljs from 'highlight.js/lib/common';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import elixir from 'highlight.js/lib/languages/elixir';
import http from 'highlight.js/lib/languages/http';
import nginx from 'highlight.js/lib/languages/nginx';
import powershell from 'highlight.js/lib/languages/powershell';
import protobuf from 'highlight.js/lib/languages/protobuf';
import scala from 'highlight.js/lib/languages/scala';

for (const [name, language] of Object.entries({
  dart,
  dockerfile,
  elixir,
  http,
  nginx,
  powershell,
  protobuf,
  scala,
})) {
  hljs.registerLanguage(name, language);
}

/** Token categories we emit as class names */
export const CODE_TOKENS = [
  'keyword',
  'type',
  'function',
  'tag',
  'attr',
  'string',
  'number',
  'comment',
  'meta',
  'variable',
  'punct',
  'inserted',
  'deleted',
  'emphasis',
  'strong',
] as const;

/** Class prefix that namespaces our token classes to avoid collisions */
export const CODE_TOKEN_PREFIX = 'spr-tok-';

/** Maps highlight.js scope names to our token categories */
const SCOPES: Record<string, (typeof CODE_TOKENS)[number]> = {
  keyword: 'keyword',
  literal: 'keyword',
  doctag: 'keyword',
  section: 'keyword',
  'selector-tag': 'keyword',
  'template-tag': 'keyword',

  type: 'type',
  built_in: 'type',
  'title.class': 'type',

  title: 'function',
  'title.function': 'function',

  tag: 'tag',
  name: 'tag',

  attr: 'attr',
  attribute: 'attr',
  property: 'attr',
  link: 'attr',
  'selector-attr': 'attr',
  'selector-class': 'attr',
  'selector-id': 'attr',
  'selector-pseudo': 'attr',

  string: 'string',
  regexp: 'string',
  symbol: 'string',
  char: 'string',
  code: 'string',
  formula: 'string',

  number: 'number',

  comment: 'comment',
  quote: 'comment',

  meta: 'meta',

  variable: 'variable',
  params: 'variable',

  subst: 'variable',
  'template-variable': 'variable',

  operator: 'punct',
  punctuation: 'punct',
  bullet: 'punct',

  addition: 'inserted',
  deletion: 'deleted',

  emphasis: 'emphasis',
  strong: 'strong',
};

/** Maximum code block size to highlight, limits memory per call */
const MAX_HIGHLIGHT_BYTES = 100_000;

/** Converts a highlight.js class list to our token class, or null if unmapped */
function tokenClass(classList: string): string | null {
  const parts = classList.split(/\s+/).filter(Boolean);
  const root = parts.find((p) => p.startsWith('hljs-'))?.slice('hljs-'.length);
  if (!root) return null;

  // highlight.js encodes sub-scopes as classes ending with underscore
  // (e.g. function_ for title.function).  Extract the modifier and look
  // up the combined scope in SCOPES
  const modifier = parts.find((p) => p.endsWith('_') && !p.endsWith('__'))?.replace(/_+$/, '');
  const token = (modifier && SCOPES[`${root}.${modifier}`]) || SCOPES[root];
  return token ? `${CODE_TOKEN_PREFIX}${token}` : null;
}

/** Replaces highlight.js span classes with our custom token classes */
function rewriteClasses(html: string): string {
  // Matches <span class="..."> and captures the class list (Group 1)
  return html.replace(/<span class="([^"]*)">/g, (_whole, classList: string) => {
    const token = tokenClass(classList);

    return token ? `<span class="${token}">` : '<span>';
  });
}

/**
 * Returns highlighted HTML for code in the given language, or null
 *
 * Not highlighting unknown or oversized code to keep the fence visible
 * in the fallback
 */
export function highlightCode(code: string, language: string): string | null {
  const name = language.trim().toLowerCase();

  if (!name || !hljs.getLanguage(name)) return null;
  if (code.length > MAX_HIGHLIGHT_BYTES) return null;

  try {
    const { value } = hljs.highlight(code, { language: name, ignoreIllegals: true });
    return rewriteClasses(value);
  } catch {
    return null;
  }
}

/** True if highlight.js has a definition for this language */
export function isHighlightable(language: string): boolean {
  return Boolean(hljs.getLanguage(language.trim().toLowerCase()));
}
