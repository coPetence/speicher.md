/**
 * The colours a template chose, read back out of the sheet it ships
 *
 * The palette form's boxes are empty where nothing has been overridden, and empty
 * is the right *value*: absence is what keeps the template's own answer, and a box
 * holding a colour would write one on the next save. But empty is a poor thing to
 * show — an operator looking at twenty-nine blank boxes cannot see what any of them
 * is going to be, and the picker beside each one opens on black. So the template's
 * own choice is shown as the box's `placeholder` and as the swatch's opening
 * colour: visible, and not submitted.
 *
 * Read out of the built sheet rather than from a table beside it, for the reason
 * `PALETTE_KEYS` is asserted against the sheet: a second copy of twenty-nine hexes
 * is one that disagrees with the stylesheet the day somebody retunes it, and the
 * disagreement is invisible — the form would show a colour the page does not use.
 * A template that ships its own sheet therefore answers for itself with no work.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PALETTE_KEYS } from '../config/palette';
import type { ColourScheme, PaletteKey } from '../config/palette';

import { DEFAULT_TEMPLATE, clientDir, clientManifest } from './assets.controller';

export type TemplatePalette = Partial<Record<PaletteKey, string>>;

/**
 * A custom property given a hex literal.
 *
 * The terminator is a lookahead over `;` *or* `}`, because the build minifies and
 * a minifier drops the semicolon on a block's last declaration — which is how
 * `--spr-callout-danger` went missing from the dark scheme and from nowhere else.
 * Consuming the brace would also swallow the start of whatever follows.
 */
const LITERAL = /(--spr-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})(?=\s*[;}])/g;

/** Only the tokens the form offers; the sheet defines plenty it does not. */
const OFFERED = new Set<string>(PALETTE_KEYS);

/**
 * Keyed on the built file's own name, which carries the hash of its bytes — so a
 * rebuild invalidates this without anybody having to remember that it exists.
 */
const cache = new Map<string, TemplatePalette>();

/** What the named template sets for each offered colour, in one scheme. */
export function templatePalette(template: string, scheme: ColourScheme): TemplatePalette {
  const manifest = clientManifest();
  const dir = clientDir();
  // The same fallback `stylesheetUrl` makes, and for the same reason: a document
  // naming a template this build does not have is served the default's sheet, so
  // the default's colours are the ones a reader would actually see.
  const file = manifest?.[`theme-${template}`] ?? manifest?.[`theme-${DEFAULT_TEMPLATE}`];
  if (!file || !dir) return {};

  const key = `${file}:${scheme}`;
  const held = cache.get(key);
  if (held) return held;

  let css: string;
  try {
    css = readFileSync(join(dir, file), 'utf8');
  } catch {
    // No sheet is not an error here: the page loses its placeholders and keeps
    // every control. Nothing about what saves depends on this.
    return {};
  }

  /*
    Each scheme is the part of the sheet that selects it, and "the part" is not a
    split at the first dark query.

    A built template sheet is self-contained: it carries the base sheet whole and
    then its own overrides after it, so a template's *light* palette sits past the
    base sheet's dark block. Cutting the file in two at that marker filed every
    override a template makes under the wrong scheme — `editorial` reported the
    base sheet's blue where its own page is rust. So the dark scheme is every dark
    query, braces matched, and the light scheme is everything left over.
  */
  const dark = darkBlocks(css);
  const block = scheme === 'dark' ? dark.join('') : strip(css, dark);

  const found: TemplatePalette = {};
  // Last declaration wins, as it does in the cascade.
  for (const [, token, hex] of block.matchAll(LITERAL)) {
    const name = token.slice('--spr-'.length);
    if (OFFERED.has(name)) found[name as PaletteKey] = hex.toLowerCase();
  }

  cache.set(key, found);
  return found;
}

/**
 * The dark-scheme blocks of a sheet, whole.
 *
 * Brace-counted from the prelude's own `{`, because a minified `@media` query
 * holds a `:root` block inside it and a regex that stopped at the first `}` would
 * take a fifth of the palette. The sheets this reads are built output — comments
 * gone, and no string in them carries a brace — so counting is enough without a
 * parser, which is the same bargain `build-client.js` makes about its own
 * substitution.
 */
function darkBlocks(css: string): string[] {
  const out: string[] = [];
  const query = /@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{/g;
  let match: RegExpExecArray | null;
  while ((match = query.exec(css)) !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < css.length && depth > 0) {
      if (css[index] === '{') depth += 1;
      else if (css[index] === '}') depth -= 1;
      index += 1;
    }
    out.push(css.slice(match.index, index));
    query.lastIndex = index;
  }
  return out;
}

/** The sheet with those blocks taken out, in order, so what is left is the rest. */
function strip(css: string, blocks: string[]): string {
  let rest = css;
  for (const block of blocks) rest = rest.replace(block, '');
  return rest;
}
