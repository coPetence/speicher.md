import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodedError } from '../../common/errors';

/** Invalid SVG mark; `mark` is the filename without `.svg` */
export class MarkError extends CodedError<'marks.no-svg' | 'marks.no-viewbox'> {
  constructor(
    code: 'marks.no-svg' | 'marks.no-viewbox',
    readonly mark: string,
    message: string,
  ) {
    super(code, message);
  }
}

interface Mark {
  viewBox: string;
  body: string;
  attrs?: string;
  defs?: string;
}

const FILE_ONLY_ATTRS = new Set(['xmlns', 'width', 'height', 'viewBox']);

export function parseMark(source: string, name: string): Mark {
  const svg = /<svg\b([^>]*)>([\s\S]*)<\/svg>/.exec(source.replace(/<!--[\s\S]*?-->/g, ''));
  if (!svg) throw new MarkError('marks.no-svg', name, `marks/${name}.svg has no <svg> element`);

  const rootAttrs = [...svg[1].matchAll(/([\w:-]+)="([^"]*)"/g)];
  const viewBox = rootAttrs.find(([, key]) => key === 'viewBox')?.[2];
  if (!viewBox) throw new MarkError('marks.no-viewbox', name, `marks/${name}.svg has no viewBox`);
  const attrs = rootAttrs
    .filter(([, key]) => !FILE_ONLY_ATTRS.has(key))
    .map(([whole]) => whole)
    .join(' ');

  const collapse = (markup: string) => markup.replace(/>\s+</g, '><').trim();
  const defs = /<defs>([\s\S]*?)<\/defs>/.exec(svg[2])?.[1];
  const body = collapse(svg[2].replace(/<defs>[\s\S]*?<\/defs>/, ''));

  return {
    viewBox,
    body,
    ...(attrs ? { attrs } : {}),
    ...(defs ? { defs: collapse(defs) } : {}),
  };
}

const MARKS_DIR = join(__dirname, 'marks');

/** Marks keyed by filename without `.svg`, loaded once at startup */
export const PROVIDER_MARKS: Record<string, Mark> = Object.fromEntries(
  readdirSync(MARKS_DIR)
    .filter((file) => file.endsWith('.svg'))
    .sort()
    .map((file) => {
      const name = file.slice(0, -'.svg'.length);
      return [name, parseMark(readFileSync(join(MARKS_DIR, file), 'utf8'), name)];
    }),
);

export function markSprite(names: Iterable<string>): string {
  const wanted = [...new Set([...names].filter((name) => name in PROVIDER_MARKS))];
  if (wanted.length === 0) return '';
  const symbols = wanted
    .map((name) => {
      const mark = PROVIDER_MARKS[name];
      const attrs = mark.attrs ? ` ${mark.attrs}` : '';
      return `<symbol id="m-${name}" viewBox="${mark.viewBox}"${attrs}>${mark.body}</symbol>`;
    })
    .join('');
  const defs = wanted.map((name) => PROVIDER_MARKS[name].defs ?? '').join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" display="none" hidden aria-hidden="true">` +
    `${symbols}</svg>` +
    (defs
      ? `<svg width="0" height="0" aria-hidden="true" focusable="false"><defs>${defs}</defs></svg>`
      : '')
  );
}

/** Check whether a mark exists */
export function markExists(name: string): boolean {
  return name in PROVIDER_MARKS;
}

export function renderMarkRef(name: string, className = 'spr-icon'): string {
  if (!markExists(name)) return '';
  const escaped = className.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return (
    `<svg class="${escaped}" width="16" height="16" aria-hidden="true">` +
    `<use href="#m-${name}"/></svg>`
  );
}

export function renderInlineMark(name: string, className: string): string {
  const mark = PROVIDER_MARKS[name];
  if (!mark) return '';
  const attrs = mark.attrs ? ` ${mark.attrs}` : '';
  const escaped = className.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return (
    `<svg class="${escaped}" width="16" height="16" viewBox="${mark.viewBox}"${attrs} ` +
    `aria-hidden="true">${mark.body}</svg>`
  );
}
