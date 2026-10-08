export type FormBody = Record<string, string | string[]>;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function decode(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (match) => ENTITIES[match] ?? match);
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decode(match[1]) : null;
}

function hasFlag(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(\\s|=|>|/)`).test(tag);
}

function add(body: FormBody, name: string, value: string): void {
  const existing = body[name];
  if (existing === undefined) body[name] = value;
  else if (Array.isArray(existing)) existing.push(value);
  else body[name] = [existing, value];
}

function controlsFor(html: string, formClass: string): string {
  const start = html.indexOf(`<form class="${formClass}"`);
  if (start < 0) throw new Error(`no form with class "${formClass}" in the page`);
  const end = html.indexOf('</form>', start);
  const id = attr(html.slice(start, html.indexOf('>', start) + 1), 'id');

  const inside = html.slice(start, end);
  const own =
    id === null
      ? inside
      : inside.replace(/<(input|select|textarea)\b[^>]*\sform="[^"]*"[^>]*>/g, '');

  if (id === null) return own;
  const associated = [
    ...html.matchAll(new RegExp(`<(input|textarea)\\b[^>]*\\sform="${id}"[^>]*>`, 'g')),
    ...html.matchAll(new RegExp(`<select\\b[^>]*\\sform="${id}"[^>]*>[\\s\\S]*?</select>`, 'g')),
  ].map((match) => match[0]);

  return own + associated.join('');
}

export function formBody(html: string, formClass = 'spr-config'): FormBody {
  const form = controlsFor(html, formClass);
  const body: FormBody = {};

  for (const [, tag] of form.matchAll(/(<input\b[^>]*>)/g)) {
    if (hasFlag(tag, 'disabled')) continue;
    const name = attr(tag, 'name');
    if (!name) continue;
    const type = attr(tag, 'type') ?? 'text';
    if (type === 'checkbox') {
      if (hasFlag(tag, 'checked')) add(body, name, attr(tag, 'value') ?? 'on');
      continue;
    }
    if (type === 'radio') {
      if (hasFlag(tag, 'checked')) add(body, name, attr(tag, 'value') ?? 'on');
      continue;
    }
    if (type === 'submit') continue;
    body[name] = attr(tag, 'value') ?? '';
  }

  for (const [, tag, inner] of form.matchAll(/(<select\b[^>]*>)([\s\S]*?)<\/select>/g)) {
    if (hasFlag(tag, 'disabled')) continue;
    const name = attr(tag, 'name');
    if (!name) continue;
    const options = [...inner.matchAll(/<option\b([^>]*)>/g)].map((m) => m[1]);
    const selected = options.find((o) => /\sselected(\s|>|$)/.test(`${o}>`)) ?? options[0];
    body[name] = selected === undefined ? '' : (attr(`<option${selected}>`, 'value') ?? '');
  }

  for (const [, tag, inner] of form.matchAll(/(<textarea\b[^>]*>)([\s\S]*?)<\/textarea>/g)) {
    if (hasFlag(tag, 'disabled')) continue;
    const name = attr(tag, 'name');
    if (name) body[name] = decode(inner);
  }

  return body;
}

export function formNames(html: string, formClass = 'spr-config'): string[] {
  return Object.keys(formBody(html, formClass));
}
