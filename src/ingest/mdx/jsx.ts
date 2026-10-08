/**
 * JSX tag and expression parser for MDX content
 *
 * Parses JSX component tags (uppercase first letter) and balanced expression blocks
 * Handles strings, template literals, and comments inside expressions
 * Tags may have text-valued, expression-valued, or flag (boolean) attributes
 *
 * Used during MDX ingestion to identify JSX fragments within markdown
 */

type AttrValue =
  | { kind: 'text'; text: string }
  | { kind: 'expression'; source: string }
  | { kind: 'flag' };

export interface JsxTag {
  kind: 'open' | 'close' | 'void';
  name: string;
  attrs: Map<string, AttrValue>;

  end: number;
}

/** Characters allowed in JSX tag names, includes $ and . for member expressions */
const NAME_CHAR = /[A-Za-z0-9_$.]/;

/** Regex matching a JSX attribute name, used with sticky flag and lastIndex */
const ATTR_NAME = /[A-Za-z_][-A-Za-z0-9_:.]*/y;
const SPACE = /\s/;

function skipSpace(src: string, pos: number, max: number): number {
  while (pos < max && SPACE.test(src[pos])) pos++;
  return pos;
}

/** Find end of a balanced `{...}` expression
 *
 * Skips over strings, template literals with interpolation,
 * block comments, and line comments to avoid false brace matching
 * Returns -1 on malformed or unclosed expression
 */
export function scanExpression(src: string, pos: number, max: number): number {
  let depth = 0;
  let i = pos;
  while (i < max) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    } else if (c === '"' || c === "'") {
      i = skipString(src, i, max, c);
      if (i < 0) return -1;
      continue;
    } else if (c === '`') {
      i = skipTemplate(src, i, max);
      if (i < 0) return -1;
      continue;
    } else if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0 || close >= max) return -1;
      i = close + 2;
      continue;
    } else if (c === '/' && src[i + 1] === '/') {
      const close = src.indexOf('\n', i);
      i = close < 0 ? max : close;
      continue;
    }
    i++;
  }
  return -1;
}

/** Skip a string literal respecting backslash escapes. Returns -1 on unclosed or newline */
function skipString(src: string, pos: number, max: number, quote: string): number {
  for (let i = pos + 1; i < max; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === quote) return i + 1;
    else if (src[i] === '\n') return -1;
  }
  return -1;
}

/** Skip a template literal, recursing into ${...} interpolations */
function skipTemplate(src: string, pos: number, max: number): number {
  for (let i = pos + 1; i < max; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '`') return i + 1;
    else if (src[i] === '$' && src[i + 1] === '{') {
      const end = scanExpression(src, i + 1, max);
      if (end < 0) return -1;
      i = end - 1;
    }
  }
  return -1;
}

/** Parse a JSX tag: <Tag>, </Tag>, or <Tag/>
 *
 * Only recognises tags starting with uppercase (JSX component convention)
 * Expression children ({...}) between attributes are silently ignored
 * Returns null on malformed syntax
 */
export function parseTag(src: string, pos: number, max: number): JsxTag | null {
  if (src[pos] !== '<') return null;
  let i = pos + 1;
  const closing = src[i] === '/';
  if (closing) i++;
  if (!/[A-Z]/.test(src[i] ?? '')) return null;

  const nameStart = i;
  while (i < max && NAME_CHAR.test(src[i])) i++;
  const name = src.slice(nameStart, i);

  if (name.endsWith('.')) return null; // Incomplete member expression like <Foo.

  const attrs = new Map<string, AttrValue>();
  for (;;) {
    i = skipSpace(src, i, max);
    if (i >= max) return null;
    const c = src[i];
    if (c === '>') return { kind: closing ? 'close' : 'open', name, attrs, end: i + 1 };
    if (closing) return null;
    if (c === '/' && src[i + 1] === '>') return { kind: 'void', name, attrs, end: i + 2 };
    if (c === '{') {
      // Skip over expression children
      const end = scanExpression(src, i, max);
      if (end < 0) return null;
      i = end;
      continue;
    }

    ATTR_NAME.lastIndex = i; // Position the sticky regex at current offset
    const match = ATTR_NAME.exec(src);
    if (!match || match.index + match[0].length > max) return null;
    const attr = match[0];
    i += attr.length;

    const eq = skipSpace(src, i, max);
    if (src[eq] !== '=') {
      attrs.set(attr, { kind: 'flag' });
      continue;
    }
    const start = skipSpace(src, eq + 1, max);
    const quote = src[start];
    if (quote === '"' || quote === "'") {
      const close = src.indexOf(quote, start + 1);
      if (close < 0 || close >= max) return null;
      attrs.set(attr, { kind: 'text', text: src.slice(start + 1, close) });
      i = close + 1;
    } else if (quote === '{') {
      const end = scanExpression(src, start, max);
      if (end < 0) return null;
      attrs.set(attr, { kind: 'expression', source: src.slice(start + 1, end - 1) });
      i = end;
    } else {
      return null;
    }
  }
}

/** Get the text value of a named attribute
 *
 * For expression-valued attributes, returns the text if the expression is a string literal
 * Template literals with interpolation are rejected; multi-line strings too for safety
 * Backslash escapes are unescaped
 */
export function attrText(tag: JsxTag, name: string): string | null {
  const value = tag.attrs.get(name);
  if (!value || value.kind === 'flag') return null;
  if (value.kind === 'text') return value.text;
  // Matches a string literal with optional surrounding whitespace
  // Group 1 is the quote character, Group 2 is the body
  const literal = /^\s*(["'`])([\s\S]*)\1\s*$/.exec(value.source);
  if (!literal) return null;
  const [, quote, body] = literal;
  if (quote === '`' && body.includes('${')) return null;
  if (quote !== '`' && body.includes('\n')) return null;
  return unescapeJs(body);
}

/** Unescape JS backslash sequences: \n, \t, and the literal character for others */
function unescapeJs(body: string): string {
  return body.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

/** Get the expression form of a named attribute, wrapped in braces, or null */
export function attrExpression(tag: JsxTag, name: string): string | null {
  const value = tag.attrs.get(name);
  return value?.kind === 'expression' ? `{${value.source}}` : null;
}
