import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CALLOUT_LEVELS } from '../../src/ingest/callouts';
import { CODE_TOKENS } from '../../src/ingest/highlight';
import { CHIP_VARIANTS } from '../../src/ingest/mdx/mdx';
import { templateNames } from '../../src/content-reader/assets.controller';
import { iconExists } from '../../src/content-reader/icons';
import { NOTE_ICON_NAMES, noteIconName } from '../../src/global-ui/note';
import { navWidthTokens } from '../../src/content-reader/views';
import { readStylesheet } from '../helpers/stylesheet';

const SOURCE = readStylesheet(join(__dirname, '../../src/global-ui/theme/default.css'));

const RULES = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@layer[^{;]*/g, '@layer');

/** The reader's content column: the shell says `data-article`, and no `/-/` page does */
const ARTICLE_MAIN = '.spr-layout[data-article] > .spr-pane > .spr-main';

function withoutTokenDefinitions(css: string): string {
  return css.replace(/:root\s*\{[^}]*\}/g, '');
}

describe('the base stylesheet', () => {
  it('declares the cascade layers, so overrides never need specificity hacks', () => {
    expect(SOURCE).toMatch(
      /@layer\s+speicher\.base\s*,\s*speicher\.theme\s*,\s*speicher\.custom\s*;/,
    );
  });

  it('puts all of its own rules in the base layer', () => {
    const outside = SOURCE.replace(/@layer speicher\.base\s*\{[\s\S]*\}\s*$/, '').trim();
    expect(
      outside
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/@layer[^;]*;/, '')
        .trim(),
    ).toBe('');
  });

  it('hard-codes no colour outside the token definitions', () => {
    const colours = withoutTokenDefinitions(RULES).match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi);
    expect(colours ?? []).toEqual([]);
  });

  it('names every token with the public prefix', () => {
    const tokens = [...SOURCE.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
    expect(tokens.length).toBeGreaterThan(25);
    expect(tokens.filter((t) => !t.startsWith('--spr-'))).toEqual([]);
  });

  it('defines every token it uses', () => {
    const defined = new Set([...SOURCE.matchAll(/(--spr-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...SOURCE.matchAll(/var\((--spr-[a-z0-9-]+)/g)].map((m) => m[1]));
    expect([...used].filter((t) => !defined.has(t))).toEqual([]);
  });

  it('defines both colour schemes, so a theme cannot half-work in dark mode', () => {
    const light = new Set(
      [...(/:root\s*\{([^}]*)\}/.exec(SOURCE)?.[1] ?? '').matchAll(/(--spr-[a-z0-9-]+)\s*:/g)].map(
        (m) => m[1],
      ),
    );
    const darkBlock = /prefers-color-scheme:\s*dark\s*\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(SOURCE);
    const dark = new Set(
      [...(darkBlock?.[1] ?? '').matchAll(/(--spr-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
    );

    expect(dark.size).toBeGreaterThan(5);
    expect([...dark].filter((t) => !light.has(t))).toEqual([]);
  });

  it('tells the browser which scheme it is drawing into', () => {
    expect(RULES).toMatch(/color-scheme:\s*var\(--spr-color-scheme\)/);
    expect(/:root\s*\{([^}]*)\}/.exec(SOURCE)?.[1]).toMatch(/--spr-color-scheme:\s*light/);
    const dark = /prefers-color-scheme:\s*dark\s*\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(SOURCE);
    expect(dark?.[1]).toMatch(/--spr-color-scheme:\s*dark/);
  });

  it('styles every syntax token the highlighter can emit', () => {
    for (const token of CODE_TOKENS) {
      expect(RULES).toContain(`.spr-tok-${token}`);
    }
  });

  it('colours every callout level the renderer can emit', () => {
    for (const level of CALLOUT_LEVELS) {
      expect(RULES).toContain(`.spr-callout-${level}`);
    }
  });

  it('numbers steps in a circle, joined by a dotted rule that stops at the last', () => {
    // A counter, because a `::marker` cannot be given a box; and the rule belongs
    // to each step, so it is as long as that step's content.
    const rule = (selector: string) =>
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')} \\{([^}]*)\\}`).exec(
        RULES,
      )?.[1] ?? '';
    expect(rule('.spr-procedure > ol > li::before')).toMatch(
      /content: counter\(spr-procedure-step\)/,
    );
    expect(rule('.spr-procedure > ol > li::before')).toMatch(/border-radius: 50%/);
    expect(rule('.spr-procedure > ol > li::after')).toMatch(/border-left: [^;]* dotted /);
    expect(rule('.spr-procedure > ol > li:last-child::after')).toMatch(/content: none/);

    // The text is aligned to the circle on the step, where `1lh` is the prose line
    // height; on the `::before` it is the circle's own, and the two came apart.
    expect(rule('.spr-procedure > ol > li')).toMatch(/padding-top: [^;]*1lh/);
    expect(rule('.spr-procedure > ol > li::before')).not.toMatch(/lh\b/);

    // As far below one circle as it stops above the next: the circle opens the
    // step, so the gap under it is what is added to its size, and the gap over
    // the next is what is left at the bottom.
    const line = rule('.spr-procedure > ol > li::after');
    const under = /top: calc\(var\(--spr-space-8\) \+ (var\(--spr-space-\d\))\)/.exec(line)?.[1];
    const over = /bottom: (var\(--spr-space-\d\))/.exec(line)?.[1];
    expect(under).toBeDefined();
    expect(under).toBe(over);
  });

  it('keeps a live tab group as tall as its tallest panel, so switching shifts nothing', () => {
    expect(RULES).toMatch(
      /\.spr-tabs\[data-spr-live\] \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\)/,
    );
    expect(RULES).toMatch(
      /\.spr-tabs\[data-spr-live\] > \.spr-tab \{[^}]*grid-row: 2;[^}]*grid-column: 1/,
    );
    expect(RULES).toMatch(
      /\.spr-tabs\[data-spr-live\] > \.spr-tab\[hidden\] \{[^}]*display: block;[^}]*visibility: hidden/,
    );
  });

  it('lets a content card show its text, and keeps a list inside it from becoming cards', () => {
    expect(declarationsOfBase('.spr-cards > li.spr-card p:not(.spr-card-title)')).toMatch(
      /line-clamp:\s*none/,
    );
    expect(declarationsOfBase('.spr-cards > li li')).toMatch(/position:\s*static/);
    expect(declarationsOfBase('.spr-cards > li li')).toMatch(/border:\s*0/);
  });

  it('colours every badge variant the renderer can emit', () => {
    expect(RULES).toMatch(/\.spr-chip \{/);
    for (const variant of CHIP_VARIANTS) {
      expect(RULES).toContain(`.spr-chip-${variant}`);
    }
  });

  it('tells a folder from a file in a file tree, and only the folder', () => {
    // A folder is an entry holding a list; without the reset, everything inside
    // a folder would inherit its weight and every entry would read as one.
    expect(RULES).toMatch(/\.spr-file-tree li:has\(> ul\) \{[^}]*font-weight/);
    expect(RULES).toMatch(/\.spr-file-tree li:has\(> ul\) > ul \{[^}]*font-weight: normal/);
  });

  it('draws a task box itself, and says its state only to a screen reader', () => {
    // No `<input>` reaches the page (the sanitiser refuses one, and nobody could
    // tick it), so the box is the stylesheet's and the words are hidden visually.
    expect(RULES).toMatch(/li\.spr-task::before \{[^}]*border:/);
    // Centred on the box's centre, then turned — not offset from its corner.
    expect(RULES).toMatch(
      /li\.spr-task-done::after \{[^}]*left: 0\.5em;[^}]*transform: translate\(-50%, -60%\) rotate\(45deg\)/,
    );
    expect(RULES).toMatch(/\.spr-task-state \{[^}]*clip-path: inset\(50%\)/);
  });

  it('honours a reader who asked for reduced motion', () => {
    expect(SOURCE).toMatch(/prefers-reduced-motion/);
  });

  it('keeps the reading measure out of the shell', () => {
    const layout = /\.spr-layout\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(layout).not.toBe('');
    expect(layout).not.toContain('--spr-measure');
    expect(/\.spr-main\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '').toContain('--spr-measure');
  });

  it('resolves the nav width through the reader, and clamps it here', () => {
    const declaration = /--spr-nav-width:([^;]*);/.exec(SOURCE)?.[1] ?? '';
    expect(declaration).toContain('clamp(');
    expect(declaration).toContain('--spr-nav-user');
    expect(declaration).toContain('--spr-nav-width-min');
    expect(declaration).toContain('--spr-nav-width-max');
  });

  it('puts the tree\u2019s disclosure after the label, inside the row\u2019s fill', () => {
    expect(declarationsOfBase('.spr-nav-toggle')).toContain(
      'margin-inline-end: var(--spr-space-1)',
    );
    expect(RULES).not.toContain('margin-inline-start: calc(-1 * var(--spr-nav-twisty))');
    expect(declarationsOfBase('.spr-nav-row:hover')).toContain('background: var(--spr-surface)');
    // The guide line drops from the folder icon's centre, and the indent gives
    // back what the line moved, so a child row starts where it always did.
    expect(declarationsOfBase('.spr-nav ul ul')).toContain(
      'margin-left: calc(var(--spr-space-4) + 8px - var(--spr-border) / 2)',
    );
    expect(declarationsOfBase('.spr-nav ul.spr-nav-tree ul')).toContain(
      'padding-left: calc(var(--spr-nav-twisty) - 8px + var(--spr-border) / 2)',
    );
  });

  it('insets the tree\u2019s row fill equally from both edges of the column', () => {
    // The column reserves a scrollbar gutter; on one side only, a classic
    // scrollbar put the fill further from the column edge than from the page's.
    expect(SOURCE).toMatch(/\.spr-nav\s*\{[^}]*scrollbar-gutter:\s*stable both-edges/);
  });

  it('sizes code relatively, through the token, and only once', () => {
    const mono = /(^|\})\s*code,\s*pre,\s*kbd,\s*samp\s*\{([^}]*)\}/.exec(RULES)?.[2] ?? '';
    expect(mono).toMatch(/font-size:\s*var\(--spr-font-size-code\)\s*;/);
    expect(/--spr-font-size-code:\s*([^;]+);/.exec(SOURCE)?.[1]).toMatch(/em$/);

    const sized = [...RULES.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(
        ([, selector, body]) =>
          /(^|[\s,>+~])(pre|code|kbd|samp)\b/.test(selector) && /font-size/.test(body),
      )
      .map(([, selector]) => selector.replace(/\s+/g, ' ').trim());
    expect(sized).toEqual(['code, pre, kbd, samp', 'pre code']);
    expect(/(^|\})\s*pre code\s*\{([^}]*)\}/.exec(RULES)?.[2] ?? '').toMatch(
      /font-size:\s*1em\s*;/,
    );
  });

  it('makes the hover preview wait, and the keyboard one not', () => {
    const hover = /a\[data-spr-preview\]:hover::after\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(hover).toContain('transition-delay: var(--spr-preview-delay)');

    const base = /a\[data-spr-preview\]::after\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(base).toContain('visibility: hidden');
    expect(base).not.toContain('transition-delay');

    const now = /a\[data-spr-preview\]:focus-visible::after[^{]*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(now).toContain('transition-delay: 0s');
    expect(RULES).toContain('[data-spr-peek] a[data-spr-preview]:hover::after');
  });

  it('never marks a link that has no preview', () => {
    expect(RULES).not.toMatch(/:not\(\[data-spr-preview\]\)/);
  });

  it('puts the related column inside the article, not in the shell', () => {
    const layout = /\.spr-layout(\[data-tree\])?\s*\{([^}]*)\}/g;
    for (const match of RULES.matchAll(layout)) {
      expect(match[2]).not.toContain('--spr-aside-width');
    }
    expect(declarationsOfBase(ARTICLE_MAIN)).toContain('--spr-aside-width');
  });

  // The article's position and width are a function of the viewport and the
  // dragged tree alone, never of the page: the track beside it is reserved on
  // every reader page, so a page with nothing to say beside it is laid out
  // exactly as its neighbour with a related column. Keyed on the aside, the
  // article's left edge moved by half an aside between two neighbouring pages.
  it('reserves the related column whether or not there is one', () => {
    expect(RULES).not.toMatch(/\.spr-main:has\(>\s*\.spr-aside\)/);
    const grid = declarationsOfBase(ARTICLE_MAIN);
    expect(grid).toMatch(/display:\s*grid/);
    expect(grid).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) var\(--spr-aside-width\)/);
    const article = declarationsOfBase(`${ARTICLE_MAIN} > .spr-article`);
    expect(article).toMatch(/max-width:\s*var\(--spr-measure\)/);
    expect(article).toMatch(/justify-self:\s*center/);
  });

  // The related column sits under the search bar: as wide as the search bar, the
  // toolbar's gap and the avatar, and inset from the pane's edge as the toolbar is.
  it('lines the related column up with the search bar', () => {
    expect(SOURCE).toMatch(
      /--spr-aside-width:\s*calc\(var\(--spr-search-width\) \+ var\(--spr-space-5\) \+ var\(--spr-avatar-size\)\)/,
    );
    expect(declarationsOfBase('.spr-toolbar')).toContain('gap: var(--spr-space-5)');
    expect(declarationsOfBase(ARTICLE_MAIN)).toContain(
      'padding-inline: var(--spr-gutter) var(--spr-space-4)',
    );
    // Its content starts where the search icon does, clear of the rounded end
    expect(/> \.spr-main > \.spr-aside\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '').toContain(
      'padding-inline-start: var(--spr-space-3)',
    );
  });

  // The breakpoint is where the second track can be afforded: the default tree,
  // the aside, four gutters (two between the tracks), and an article still wide enough to read. Computed
  // from the tokens rather than trusted, so a retuned aside or gutter moves it.
  it('opens the second track only where the article keeps a readable width', () => {
    const rem = (token: string): number =>
      Number(new RegExp(`${token}:\\s*([0-9.]+)rem`).exec(SOURCE)?.[1]);
    const gutterToken = /--spr-gutter:\s*var\((--spr-space-[0-9]+)\)/.exec(SOURCE)?.[1] ?? '';
    const breakpoint = Number(
      new RegExp(
        `@media \\(min-width: ([0-9.]+)rem\\) \\{\\s*${ARTICLE_MAIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`,
      ).exec(RULES)?.[1],
    );
    const aside = rem('--spr-search-width') + rem('--spr-space-5') + rem('--spr-avatar-size');
    const article =
      breakpoint -
      rem('--spr-nav-width-default') -
      aside -
      3 * rem(gutterToken) -
      rem('--spr-space-4');
    for (const value of [breakpoint, article]) expect(Number.isFinite(value)).toBe(true);
    // Narrower than this and the pair is not worth having beside each other
    expect(article).toBeGreaterThanOrEqual(36);
    // And not so wide that a laptop never sees the column
    expect(breakpoint).toBeLessThanOrEqual(80);
  });

  // Every reader template is swapped into the same `.spr-main`, and every one
  // of them is laid out on the reserved grid — so each has to hand it exactly
  // one item to place, or its paragraphs land in the cells.
  // The aside starts level with the page's title. Article and aside share one
  // row, so a long aside next to a short page cannot stretch a heading row and
  // open a gap under the title.
  it('starts the related column level with the page\u2019s title', () => {
    expect(RULES).not.toMatch(/grid-template-rows:\s*subgrid/);
    // Or a short page's row stretches to the scroller's height.
    expect(declarationsOfBase(ARTICLE_MAIN)).toMatch(/align-content:\s*start/);
    const aside = /> \.spr-main > \.spr-aside\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(aside).toMatch(/grid-row:\s*1;/);
    expect(aside).toMatch(/align-self:\s*start/);
  });

  it('puts the room to scroll the last line up after the related pages', () => {
    expect(RULES).toMatch(
      /@media not all and \(min-width: 80rem\) \{\s*\.spr-article:has\(\+ \.spr-aside\) \{\s*padding-bottom: 0;\s*\}\s*\.spr-article \+ \.spr-aside \{\s*padding-bottom: 20vh;/,
    );
  });

  // A hidden box still widens the scroll area, so a preview that were only
  // invisible would scroll the page sideways from a link near the right edge.
  it('takes a hidden preview out of the layout', () => {
    const base = /a\[data-spr-preview\]::after\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(base).toMatch(/display:\s*none/);
    expect(base).toMatch(/transition-behavior:\s*allow-discrete/);
    const hover = /a\[data-spr-preview\]:hover::after\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(hover).toMatch(/display:\s*block/);
    const now = /a\[data-spr-preview\]:focus-visible::after[^{]*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(now).toMatch(/display:\s*block/);
  });

  // Placed against the pane rather than the link, so the browser sees when a
  // preview would leave it and tries the next placement. Guarded, so a browser
  // without anchor positioning keeps the preview at the link's start.
  describe('keeping a preview inside the pane', () => {
    const block =
      /@supports \(anchor-scope: all\) and \(position-try-fallbacks: flip-inline\) \{([\s\S]*?)\n {2}\}\n/.exec(
        RULES,
      )?.[1] ?? '';

    it('anchors each preview to its own link', () => {
      const link = ruleFor(block, 'a[data-spr-preview]');
      expect(link).toMatch(/position:\s*static/);
      expect(link).toMatch(/anchor-name:\s*--spr-preview/);
      expect(link).toMatch(/anchor-scope:\s*--spr-preview/);
      expect(ruleFor(block, '.spr-pane')).toMatch(/position:\s*relative/);
    });

    it('tries the other side, then above, then the pane’s full width', () => {
      const preview = ruleFor(block, 'a[data-spr-preview]::after').replace(/\s+/g, ' ');
      expect(preview).toContain('position-anchor: --spr-preview');
      expect(preview).toContain('position-area: block-end span-inline-end');
      expect(preview).toContain(
        'position-try-fallbacks: flip-inline, flip-block, flip-block flip-inline, --spr-preview-full, --spr-preview-full flip-block',
      );
    });

    // Chrome never accepts the option written as `position-area: block-end span-all`
    it('writes the full-width option with insets from the anchor', () => {
      const full = /@position-try --spr-preview-full \{([^}]*)\}/.exec(block)?.[1] ?? '';
      expect(full).toMatch(/position-area:\s*none/);
      expect(full).toMatch(/top:\s*anchor\(bottom\)/);
      expect(full).toMatch(/left:\s*var\(--spr-space-4\)/);
      expect(full).toMatch(/right:\s*var\(--spr-space-4\)/);
    });

    it('keeps the link-relative preview outside the guard', () => {
      expect(declarationsOfBase('a[data-spr-preview]')).toMatch(/position:\s*relative/);
      const base = /a\[data-spr-preview\]::after\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
      expect(base).toMatch(/max-width:\s*var\(--spr-preview-width\)/);
      expect(base).toMatch(/left:\s*0/);
    });
  });

  it('wraps every reader template in the article, before any aside', () => {
    expect(RULES).toMatch(/\.spr-article\b/);
    const views = join(__dirname, '../../src/content-reader/views');
    const names = readdirSync(views);
    expect(names.length).toBeGreaterThan(3);
    for (const name of names) {
      const template = readFileSync(join(views, name, `${name}.eta`), 'utf8');
      expect(template).toContain('<div class="spr-article">');
      const aside = template.indexOf('<aside class="spr-aside"');
      if (aside >= 0) expect(template.lastIndexOf('</div>', aside)).toBeGreaterThan(0);
      expect(template.trimEnd().endsWith('</div>') || aside >= 0).toBe(true);
      // And the view sets the shell attribute the grid is keyed on
      expect(readFileSync(join(views, name, `${name}.ts`), 'utf8')).toContain('article: true');
    }
  });

  // A short page has no scrollbar and a long one has; the padding trick then
  // re-centres on what is left and the article moves by half a scrollbar.
  it('reserves the scrollbar\u2019s space in both scrollers', () => {
    const scrollers = /\.spr-nav,\s*\.spr-main\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(scrollers).toMatch(/overflow-y:\s*auto/);
    expect(scrollers).toMatch(/scrollbar-gutter:\s*stable/);
  });

  it('sets the mark beside a related link level with its first line, at the aside\u2019s own size', () => {
    const mark = declarationsOfBase('.spr-aside-list a .spr-icon');
    expect(mark).toMatch(/align-self:\s*flex-start/);
    expect(mark).toMatch(/width:\s*1em/);
    expect(mark).toMatch(/height:\s*1lh/);
    expect(declarationsOfBase('.spr-aside-list a')).toMatch(/align-items:\s*baseline/);
  });

  // A navigation between a reading page (toolbar in the card) and any other page
  // (toolbar in the header) must not move the logo or the search box. Both shells
  // are built from the same four numbers; each is asserted on both sides.
  describe('puts the logo and the search box in one place in both shells', () => {
    const space = (n: number) => `var(--spr-space-${n})`;
    const wide = /@media \(min-width: 48rem\) \{([\s\S]*?)\n {2}\}\n/.exec(RULES)?.[1] ?? '';
    const inWide = (selector: string) => ruleFor(wide, selector);

    it('starts the logo where the tree\u2019s items start', () => {
      const inset = /padding-inline:\s*(var\(--spr-space-[0-9]+\))/.exec(
        declarationsOfBase('.spr-nav'),
      )?.[1];
      const lead = /padding-inline-start:\s*(var\(--spr-space-[0-9]+\))/.exec(
        declarationsOfBase('.spr-nav a'),
      )?.[1];
      expect(inset).toBe(space(3));
      expect(lead).toBe(space(4));
      expect(declarationsOfBase('.spr-header')).toMatch(
        /padding-inline:\s*calc\(var\(--spr-space-3\) \+ var\(--spr-space-4\)\)/,
      );
      // The docked header narrows its column and changes nothing else.
      expect(declarationsOfBase('.spr-layout[data-docked] > .spr-header')).not.toMatch(/padding/);
      // The tree's gutter is reserved on both edges, so the brand reserves it too.
      expect(inWide('.spr-brand')).toMatch(/scrollbar-gutter:\s*stable both-edges/);
      // A gutter is as wide as its scrollbar, so the two must be the same width.
      const navWidth = /\.spr-nav \{[^}]*scrollbar-width:\s*([a-z]+)/.exec(wide)?.[1];
      expect(navWidth).toBe('thin');
      expect(inWide('.spr-brand')).toContain(`scrollbar-width: ${navWidth}`);
    });

    it('gives the bar one height, whatever is in it', () => {
      expect(declarationsOfBase('.spr-brand')).toContain('min-block-size: var(--spr-bar-height)');
      expect(declarationsOfBase('.spr-toolbar')).toContain('min-block-size: var(--spr-bar-height)');
      expect(declarationsOfBase('.spr-toolbar')).not.toMatch(/padding/);
    });

    it('starts the bar the same distance down', () => {
      // Narrow, both shells stack, and the bar sits space-4 down in each.
      expect(declarationsOfBase('.spr-header')).toContain(`padding-block: ${space(4)}`);
      expect(declarationsOfBase('.spr-pane > .spr-toolbar')).toContain(`margin-block: ${space(4)}`);
      // Wide, space-6 down, with nothing under the header's bar: the card's own
      // margin is the gap above a card.
      expect(inWide('.spr-header')).toContain(`padding-block: ${space(6)} 0`);
      // In the card: the card's own inset plus the toolbar's margin.
      expect(inWide('.spr-layout[data-docked][data-tree] > .spr-pane')).toContain(
        `margin-block-start: ${space(3)}`,
      );
      expect(inWide('.spr-pane > .spr-toolbar')).toContain(
        `margin-block: calc(${space(6)} - ${space(3)}) 0`,
      );
      // An offset would draw the search box below the logo's row and over the page.
      expect(inWide('.spr-toolbar')).not.toMatch(/(^|[\s;])top:/);
      // The card clips 2.4px above the box, so the ring must sit on the border.
      expect(
        inWide(".spr-pane > .spr-toolbar .spr-search input[type='search']:focus-visible"),
      ).toMatch(/outline-offset:\s*0/);
    });

    it('ends the toolbar the same distance from the right', () => {
      const end = `calc(${space(3)} + ${space(4)})`;
      expect(declarationsOfBase('.spr-header').replace(/\s+/g, ' ')).toContain(
        `padding-inline: calc(${space(3)} + ${space(4)}) ${end}`,
      );
      expect(declarationsOfBase('.spr-pane > .spr-toolbar')).toContain(
        `padding-inline-end: ${end}`,
      );
      // In the card: the card's inset plus the toolbar's padding.
      expect(wide).toMatch(
        new RegExp(`\\.spr-pane \\{[^}]*margin: 0 var\\(--spr-space-3\\) var\\(--spr-space-3\\);`),
      );
      expect(inWide('.spr-pane > .spr-toolbar')).toContain(`padding-inline: ${space(4)}`);
    });

    // Blueprint takes the card's inset and the tree's inset away, so whatever
    // held those shares of the sums must hold them itself — or the search box
    // jumps between the two shells, or the logo leaves the tree's line.
    describe('in a template that removes the insets', () => {
      const blueprint = readFileSync(
        join(__dirname, '../../src/global-ui/theme/blueprint.css'),
        'utf8',
      );
      const bpWide = [...blueprint.matchAll(/@media \(min-width: 48rem\) \{([\s\S]*?)\n {2}\}\n/g)]
        .map((m) => m[1])
        .join('\n');

      it('keeps the toolbar where the header puts it', () => {
        expect(ruleFor(bpWide, '.spr-pane')).toMatch(/margin:\s*0;/);
        const toolbar = ruleFor(bpWide, '.spr-pane > .spr-toolbar');
        expect(toolbar).toContain(`margin-block-start: ${space(6)}`);
        expect(toolbar).toContain(`padding-inline-end: calc(${space(3)} + ${space(4)})`);
      });

      it('keeps the logo on the tree\u2019s line', () => {
        expect(ruleFor(blueprint, '.spr-nav')).toMatch(/padding-inline:\s*0;/);
        // The column's inset is gone, so the logo's is a row's lead alone.
        expect(ruleFor(blueprint, '.spr-header')).toContain(`padding-inline-start: ${space(4)}`);
        // A gutter on the left would put the inset back for classic scrollbars,
        // and the brand must then reserve none either.
        expect(ruleFor(bpWide, '.spr-nav')).toMatch(/scrollbar-gutter:\s*stable;/);
        expect(ruleFor(bpWide, '.spr-brand')).toMatch(/scrollbar-gutter:\s*auto;/);
      });
    });
  });

  // On a phone the search box, the tree and the account items wait behind a menu
  // button. Only where `:has()` can read the button's state: elsewhere nothing is
  // hidden and no button is drawn, which is the plainer page rather than a broken
  // one. The width is the exact complement of the two-pane breakpoint.
  it('collapses the chrome behind a menu on a phone, and only where it can open', () => {
    expect(RULES).toMatch(/\.spr-menu,\s*\.spr-menu-account\s*\{\s*display:\s*none/);
    const collapse =
      /@supports selector\(:has\(\*\)\) \{\s*@media not all and \(min-width: ([0-9.]+rem)\) \{([\s\S]*?)\n {4}\}\n {2}\}/.exec(
        RULES,
      );
    expect(collapse?.[1]).toBe('48rem');
    expect(RULES).toContain('@media (min-width: 48rem) {');
    const body = collapse?.[2] ?? '';
    expect(ruleFor(body, '.spr-menu')).toMatch(/display:\s*block/);
    expect(body).toMatch(
      /\.spr-layout:not\(:has\(> \.spr-header \.spr-menu\[open\]\)\) > \.spr-nav\s*\{\s*display:\s*none/,
    );
    // Open, it is the whole screen: the shell is a fixed layer with the page left
    // out, the document under it does not scroll, and the bar stays in reach.
    const open = '.spr-layout:has(> .spr-header .spr-menu[open])';
    expect(ruleFor(body, open)).toMatch(/position:\s*fixed/);
    expect(ruleFor(body, open)).toMatch(/inset:\s*0/);
    expect(ruleFor(body, open)).toMatch(/overflow-y:\s*auto/);
    // The account items at the foot: the tree's row takes what is left.
    expect(ruleFor(body, open)).toMatch(/grid-template-rows:\s*auto auto 1fr auto/);
    expect(ruleFor(body, '.spr-nav')).toMatch(/grid-row:\s*3/);
    expect(ruleFor(body, '.spr-menu-account')).toMatch(/grid-row:\s*4/);
    expect(ruleFor(body, `${open} .spr-main`)).toMatch(/display:\s*none/);
    expect(ruleFor(body, `${open} > .spr-header`)).toMatch(/position:\s*sticky/);
    expect(ruleFor(body, 'body:has(.spr-menu[open])')).toMatch(/overflow:\s*hidden/);
    // Sign-out shares the name's row as a mark alone, keeping its word for a
    // screen reader; the appearance choice stays, in line with the rest.
    expect(ruleFor(body, '.spr-menu-account > .spr-account-who')).toMatch(/grid-row:\s*1/);
    expect(ruleFor(body, '.spr-menu-account > .spr-signout')).toMatch(/grid-row:\s*1/);
    expect(ruleFor(body, '.spr-menu-account > .spr-signout span')).toMatch(
      /clip-path:\s*inset\(50%\)/,
    );
    expect(ruleFor(body, '.spr-menu-account > .spr-scheme')).not.toMatch(/display:\s*none/);
    // The avatar's dropdown is not drawn there; its items are in the menu instead.
    expect(body).toMatch(
      /\.spr-toolbar > \.spr-account,\s*\.spr-toolbar > \.spr-signin\s*\{\s*display:\s*none/,
    );
  });

  it('leaves the dashboard notice to the note component', () => {
    expect(declarationsOfBase('.spr-note')).toBe('');
  });

  it('lays a set of pages to pick from out as cards, the whole of each being the link', () => {
    expect(declarationsOfBase('.spr-cards')).toMatch(
      /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(/,
    );
    expect(declarationsOfBase('.spr-cards li')).toMatch(/position:\s*relative/);
    expect(declarationsOfBase('.spr-cards li > a::after')).toMatch(/position:\s*absolute/);
    expect(declarationsOfBase('.spr-cards li > a::after')).toMatch(/inset:\s*0/);
    expect(RULES).not.toMatch(/\.spr-cards li a(::after)?\s*[{,]/);
    // Muted until the card is hovered or focused, then the body colour — never an
    // underline, since the target is the card rather than the title.
    expect(declarationsOfBase('.spr-cards li')).toMatch(/color:\s*var\(--spr-muted\)/);
    expect(declarationsOfBase('.spr-cards li:has(> a:focus-visible)')).toMatch(
      /color:\s*var\(--spr-fg\)/,
    );
    expect(RULES).not.toMatch(/\.spr-cards[^{]*\{[^}]*text-decoration:\s*underline/);
    expect(declarationsOfBase('.spr-cards p')).toMatch(/-webkit-line-clamp:\s*2/);
    expect(declarationsOfBase('.spr-cards p')).toMatch(/overflow:\s*hidden/);
    expect(declarationsOfBase('.spr-cards p')).toMatch(/font-size:\s*var\(--spr-font-size-small\)/);
    expect(declarationsOfBase('.spr-cards p')).toMatch(
      /line-height:\s*var\(--spr-line-height-tight\)/,
    );
    for (const view of ['content-page', 'folder-listing', 'tag']) {
      const template = readFileSync(
        join(__dirname, '../../src/content-reader/views', view, `${view}.eta`),
        'utf8',
      );
      expect(template).toContain('<ul class="spr-listing spr-cards">');
    }
  });

  it('opens every reading page with its title, the way the listing already does', () => {
    const views = Object.fromEntries(
      ['content-page', 'folder-listing'].map((view) => [
        view,
        readFileSync(
          join(__dirname, '../../src/content-reader/views', view, `${view}.eta`),
          'utf8',
        ),
      ]),
    );
    for (const template of Object.values(views)) {
      const h1 = template.indexOf('<h1');
      expect(h1).toBeGreaterThan(-1);
      expect(template.indexOf('@crumbs')).toBeLessThan(h1);
      expect(h1).toBeLessThan(template.indexOf('it.cover'));
      const heading = template.slice(h1, template.indexOf('</h1>', h1));
      expect(heading).toMatch(/<%~\s*it\.icon/);
    }
    const article = views['content-page'].indexOf('<div class="spr-article">');
    expect(article).toBeGreaterThan(-1);
    expect(article).toBeLessThan(views['content-page'].indexOf('<h1'));

    const mark = declarationsOfBase('.spr-main h1 .spr-icon');
    expect(mark).toMatch(/width:\s*1em/);
    expect(mark).toMatch(/height:\s*1em/);
  });

  it('crops a cover to one ratio, at two widths', () => {
    // The card and the landing page are two drawings of one repository. A height
    // token answered only the card, so the shared fact is the ratio: what the page
    // answers again is its width, and nothing else.
    const box = declarationsOfBase('.spr-cover');
    expect(box).toMatch(/aspect-ratio:\s*var\(--spr-cover-ratio\)/);
    expect(box).toMatch(/width:\s*var\(--spr-cover-width\)/);
    expect(box).not.toMatch(/height:/);
    expect(RULES).toMatch(/--spr-cover-ratio:\s*\d+\s*\/\s*\d+/);

    const page = declarationsOfBase('.spr-cover-page');
    expect(page).toMatch(/width:\s*100%/);
    expect(page).not.toMatch(/aspect-ratio|height/);

    // `.spr-main img` sets `height: auto` at one class and one element, so the
    // crop needs two classes to outweigh it — the trap the rule's own comment
    // names, and the reason the page is in that selector list rather than beside it.
    const img = declarationsOfBase('.spr-cover.spr-cover-page img');
    expect(img).toMatch(/object-fit:\s*cover/);
    expect(img).toMatch(/height:\s*100%/);
  });

  it('lays the brand out as a mark beside a word', () => {
    const brand = /\.spr-brand\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(brand).toMatch(/display:\s*flex/);
    expect(brand).toMatch(/gap:\s*var\(--spr-space-\d\)/);
    const mark = /\.spr-brand-mark\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(mark).toMatch(/width:\s*var\(--spr-brand-mark-size\)/);
    expect(mark).toMatch(/height:\s*var\(--spr-brand-mark-size\)/);
    expect(RULES).toMatch(/--spr-brand-mark-size:\s*[\d.]+em/);
  });

  it('sizes the external link mark against the text, also inside a heading', () => {
    const mark = declarationsOfBase('.spr-main a > .spr-icon.spr-link-external');
    expect(mark).toMatch(/width:\s*0\.75em/);
    expect(mark).toMatch(/height:\s*0\.75em/);
    // Comes after the heading icon rule, so it wins inside a heading too
    expect(RULES.indexOf('.spr-main a > .spr-icon.spr-link-external')).toBeGreaterThan(
      RULES.indexOf('.spr-main h1 .spr-icon'),
    );
    expect(declarationsOfBase('.spr-visually-hidden')).toMatch(/clip-path:\s*inset\(50%\)/);
  });

  it('breaks a word longer than the column instead of letting it overflow', () => {
    expect(declarationsOfBase('.spr-article')).toMatch(/overflow-wrap:\s*break-word/);
  });

  it('moves the name below the logo in one piece instead of breaking it', () => {
    const brand = /\.spr-brand\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(brand).toMatch(/flex-wrap:\s*wrap/);
    expect(brand).toMatch(/min-width:\s*0/);
    const name = /(?:^|\n)\s*\.spr-brand-name\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(name).toMatch(/white-space:\s*nowrap/);
    expect(name).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('sets the name on the logo’s bottom edge by its baseline', () => {
    const rule = /\.spr-brand\[data-align='bottom'\]\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(rule).toMatch(/align-items:\s*last baseline/);
  });

  it('ends the name at its baseline, so the logo stays where centring puts it', () => {
    const name =
      /\.spr-brand\[data-align='bottom'\] > \.spr-brand-name\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(name).toMatch(/text-box:\s*trim-end cap alphabetic/);
    expect(/\.spr-brand\s*\{([^}]*)\}/.exec(RULES)?.[1]).toMatch(/align-content:\s*center/);
  });

  it('sizes the brand logo from tokens, and only its height', () => {
    const rule = /\.spr-brand img\s*\{([^}]*)\}/.exec(RULES)?.[1] ?? '';
    expect(rule).not.toBe('');
    expect(rule).toMatch(/height:\s*var\(--spr-brand-logo-height\)/);
    expect(rule).toMatch(/max-width:\s*min\(var\(--spr-brand-logo-max-width\),\s*100%\)/);
    expect(rule).toMatch(/object-fit:\s*contain/);
    expect(rule).toMatch(/width:\s*auto/);
    expect(rule).toMatch(/display:\s*block/);
  });

  it('keeps the attribution visible where the shell owns the viewport', () => {
    expect(RULES).toMatch(/\.spr-attribution\s*\{/);
    const twoPane = /@media \(min-width: 48rem\) \{([\s\S]*?)\n {2}\}/.exec(RULES)?.[1] ?? '';
    expect(twoPane).not.toBe('');
    expect(twoPane).toMatch(/\.spr-attribution[^{]*\{[^}]*flex:\s*0 0 auto/);
  });

  it('draws the sign-in options as centred buttons carrying a mark', () => {
    const option = RULES.match(/\.spr-signin-option\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(option).toMatch(/display:\s*flex/);
    expect(option).toMatch(/align-items:\s*center/);
    expect(option).toMatch(/justify-content:\s*center/);
    expect(option).toMatch(/border:\s*var\(--spr-border\)/);
    expect(option).toMatch(/text-decoration:\s*none/);

    const column = RULES.match(/\.spr-signin-options\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(column).toMatch(/list-style:\s*none/);
    expect(column).toMatch(/max-width:/);

    const mark = RULES.match(/\.spr-signin-mark\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(mark).toMatch(/width:\s*1\.25em/);
    expect(mark).toMatch(/height:\s*1\.25em/);

    expect(RULES).toMatch(/\.spr-form input\[type='email'\]/);

    expect(RULES).not.toMatch(/\.spr-signin\s+\./);
    expect(RULES).toMatch(/\.spr-signin-page \.spr-form\s*\{/);
  });

  it('does not hand a column form\u2019s inputs the row\u2019s flex basis as a height', () => {
    const block = RULES.match(
      /\.spr-form-block input\[type='search'\],\s*\.spr-form-block input\[type='text'\],\s*\.spr-form-block input\[type='email'\]\s*\{([^}]*)\}/,
    )?.[1];
    expect(block).toBeDefined();
    expect(block).toMatch(/flex:\s*0 0 auto/);
  });

  it('styles only prefixed classes, which are the public contract', () => {
    const classes = [...RULES.matchAll(/\.([a-z][a-z0-9-]*)/gi)].map((m) => m[1]);
    expect(new Set(classes).size).toBeGreaterThan(8);
    expect([...new Set(classes)].filter((c) => !c.startsWith('spr-'))).toEqual([]);
  });
});

const EXTRA_SHEETS = [
  ['dashboard.css', '../../src/dashboard/ui/dashboard.css'],
  ['setup-claim.css', '../../src/dashboard/ui/views/setup/setup-claim/setup-claim.css'],
] as const;

const sheetSource = (path: string) => readStylesheet(join(__dirname, path));
const rulesOf = (css: string) =>
  css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@layer[^{;]*/g, '@layer');

const DASHBOARD = sheetSource(EXTRA_SHEETS[0][1]);
const DASHBOARD_RULES = rulesOf(DASHBOARD);

describe('the read chart', () => {
  it('stays out of the reader\u2019s stylesheet entirely', () => {
    expect(DASHBOARD_RULES).toMatch(/\.spr-chart\s*\{/);
    expect(SOURCE).not.toContain('spr-chart');
    for (const name of readdirSync(THEME_DIR).filter((f) => f.endsWith('.css'))) {
      expect(readFileSync(join(THEME_DIR, name), 'utf8')).not.toContain('spr-chart');
    }
  });

  it('is sized, since an unsized SVG draws at 300x150', () => {
    const rule = /\.spr-chart\s*\{([^}]*)\}/.exec(DASHBOARD_RULES)?.[1] ?? '';
    expect(rule).toMatch(/\bwidth\s*:/);
    expect(rule).toMatch(/\bheight\s*:/);
  });
});

describe('the claim command', () => {
  const setup = sheetSource(EXTRA_SHEETS.find(([name]) => name === 'setup-claim.css')?.[1] ?? '');
  const rule = (selector: string) =>
    new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(
      setup,
    )?.[1] ?? '';

  it('is set at the code-block size, so the longest code fits on one line', () => {
    const command = rule('.spr-claim-run > .spr-claim-command');
    expect(command).not.toBe('');
    expect(command).not.toMatch(/font-size/);
  });

  it('sets the copy button beside the command, in the flow', () => {
    expect(rule('.spr-claim-run')).toMatch(/display:\s*flex/);
    expect(rule('.spr-claim-run > .spr-claim-command')).toMatch(/min-inline-size:\s*0/);
    expect(rule('.spr-copy')).not.toMatch(/position:\s*absolute/);
  });

  it('hides the copy button until the island reveals it', () => {
    expect(rule('.spr-copy')).toMatch(/display:\s*flex/);
    expect(rule('.spr-copy[hidden]')).toMatch(/display:\s*none/);
  });

  it('sizes the icon, which renderInlineIcon leaves unsized', () => {
    expect(rule('.spr-copy .spr-icon')).toMatch(/inline-size:\s*[\d.]+em/);
  });
});

describe('a dashboard notice', () => {
  const css = rulesOf(sheetSource('../../src/global-ui/components/note/note.css'));
  const icon = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('draws the icon of its level, info when it names none', () => {
    expect(noteIconName(undefined)).toBe('info');
    expect(noteIconName('idle')).toBe('info');
    expect(noteIconName('ok')).toBe('circle-check');
    expect(noteIconName('warn')).toBe('triangle-alert');
    expect(noteIconName('fail')).toBe('circle-x');
  });

  it('names only icons lucide ships', () => {
    expect(NOTE_ICON_NAMES.filter((name) => !iconExists(name))).toEqual([]);
  });

  it('colours the icon in the accent of its level', () => {
    expect(icon('.spr-note > .spr-icon:first-child')).toMatch(
      /color:\s*var\(--spr-status-accent\)/,
    );
  });

  it('is tinted blue, the info colour, when its level is neutral', () => {
    expect(icon('.spr-note:not(.spr-note-ok, .spr-note-warn, .spr-note-fail)')).toMatch(
      /--spr-status-accent:\s*var\(--spr-callout-info\)/,
    );
  });
});

describe.each(EXTRA_SHEETS)('the %s stylesheet', (_name, path) => {
  const css = sheetSource(path);
  const rules = rulesOf(css);

  it('hard-codes no colour', () => {
    expect(rules.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? []).toEqual([]);
  });

  it('invents no token of its own, and only ever re-answers one the base sheet has', () => {
    const set = [...rules.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
    const defined = new Set([...SOURCE.matchAll(/(--spr-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    expect(set.filter((token) => !defined.has(token))).toEqual([]);
    expect(new Set(set).size).toBeLessThanOrEqual(2);
  });

  it('uses only tokens the base sheet defines', () => {
    const defined = new Set([...SOURCE.matchAll(/(--spr-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\((--spr-[a-z0-9-]+)/g)].map((m) => m[1]));
    expect([...used].filter((t) => !defined.has(t))).toEqual([]);
    expect(used.size).toBeGreaterThan(0);
  });

  it('puts its rules in the base layer, so a template still wins', () => {
    expect(css.trimStart()).toMatch(/^(\/\*[\s\S]*?\*\/\s*)?@layer speicher\.base\s*\{/);
    expect(css).not.toMatch(/@layer\s+[a-z.]+\s*,/);
  });

  it('styles only prefixed classes', () => {
    const classes = [...rules.replace(/url\([^)]*\)/g, '').matchAll(/\.([a-z][a-z0-9-]*)/gi)].map(
      (m) => m[1],
    );
    expect(new Set(classes).size).toBeGreaterThan(0);
    expect([...new Set(classes)].filter((c) => !c.startsWith('spr-'))).toEqual([]);
  });
});

describe('the colour-scheme variants', () => {
  const dir = join(__dirname, '../../dist/client');
  const built = (): Record<string, string> =>
    JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, string>;

  it('was built, which every check below filters a list produced by', () => {
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
  });

  const templates = readdirSync(join(__dirname, '../../src/global-ui/theme'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => f.replace(/\.css$/, ''));

  it.each(templates)('gives %s a sheet per answer a reader can give', (name) => {
    const manifest = built();
    const sheets = [`theme-${name}`, `theme-light-${name}`, `theme-dark-${name}`].map(
      (key) => manifest[key],
    );
    expect(sheets.filter(Boolean)).toHaveLength(3);
    expect(new Set(sheets).size).toBe(3);
  });

  it.each(templates)('takes the question out of %s rather than answering it twice', (name) => {
    const manifest = built();
    const read = (key: string) => readFileSync(join(dir, manifest[key]), 'utf8');

    expect(read(`theme-${name}`)).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);

    for (const [scheme, prelude] of [
      ['dark', '@media all{'],
      ['light', '@media not all{'],
    ] as const) {
      const css = read(`theme-${scheme}-${name}`);
      expect(css).not.toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
      expect(css).toContain(prelude);
    }

    expect(read(`theme-dark-${name}`)).toMatch(/@media all\{[^}]*--spr-color-scheme:\s*dark/);
  });

  const inScheme = (css: string, scheme: 'light' | 'dark'): string => {
    const QUERY = /@media\s*(\(prefers-color-scheme:\s*dark\)|not all|all)\s*\{/;
    let out = '';
    let rest = css;
    for (;;) {
      const found = QUERY.exec(rest);
      if (!found) return out + rest;

      out += rest.slice(0, found.index);
      const opens = found.index + found[0].length;
      let depth = 1;
      let index = opens;
      while (index < rest.length && depth > 0) {
        if (rest[index] === '{') depth += 1;
        else if (rest[index] === '}') depth -= 1;
        index += 1;
      }

      const on = found[1] === 'all' || (found[1] !== 'not all' && scheme === 'dark');
      out += on ? rest.slice(opens, index - 1) : '';
      rest = rest.slice(index);
    }
  };

  const weightAgainst = (selector: string, variant: string): number | null => {
    const parts = selector.trim().split(/\s+/);
    if (parts.length > 2) return null;
    if (parts.length === 2 && parts[0] !== '.spr-brand') return null;

    const own = new Set(['img', '.spr-brand-logo', `.spr-brand-logo-${variant}`]);
    const pieces = parts[parts.length - 1].split(/(?=\.)/).filter(Boolean);
    if (!pieces.every((piece) => own.has(piece))) return null;

    const classes = pieces.filter((piece) => piece.startsWith('.')).length + (parts.length - 1);
    return classes * 10 + pieces.filter((piece) => !piece.startsWith('.')).length;
  };

  const displayOf = (css: string, variant: string, scheme: 'light' | 'dark'): string => {
    let best = { weight: -1, order: -1, value: 'inline' };
    let order = 0;

    for (const [, selectors, body] of inScheme(css, scheme).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      order += 1;
      const display = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(body)?.[1]?.trim();
      if (display === undefined) continue;

      for (const selector of selectors.split(',')) {
        const weight = weightAgainst(selector, variant);
        if (weight === null) continue;
        if (weight > best.weight || (weight === best.weight && order > best.order)) {
          best = { weight, order, value: display };
        }
      }
    }
    return best.value;
  };

  it.each(templates)('draws one of two logos in %s, never both', (name) => {
    const manifest = built();
    const read = (key: string) => readFileSync(join(dir, manifest[key]), 'utf8');

    const drawn = (key: string, scheme: 'light' | 'dark') => ({
      light: displayOf(read(key), 'light', scheme),
      dark: displayOf(read(key), 'dark', scheme),
    });

    expect(drawn(`theme-${name}`, 'light')).toEqual({ light: 'block', dark: 'none' });
    expect(drawn(`theme-${name}`, 'dark')).toEqual({ light: 'none', dark: 'block' });

    for (const scheme of ['light', 'dark'] as const) {
      expect(drawn(`theme-light-${name}`, scheme)).toEqual({ light: 'block', dark: 'none' });
      expect(drawn(`theme-dark-${name}`, scheme)).toEqual({ light: 'none', dark: 'block' });
    }
  });

  it.each(templates)('leaves the only logo there is alone in %s', (name) => {
    const manifest = built();
    const css = readFileSync(join(dir, manifest[`theme-${name}`]), 'utf8');

    for (const scheme of ['light', 'dark'] as const) {
      expect(displayOf(css, 'neither', scheme)).toBe('block');
    }
  });

  it('keeps the scheme out of the templates an operator is offered', () => {
    expect(templateNames().sort()).toEqual(templates.sort());
    const build = readFileSync(join(__dirname, '../../scripts/build-client.ts'), 'utf8');
    expect(build).toContain('a template may not be called');
  });
});

describe('the client manifest', () => {
  it('gives stylesheets and islands names that cannot collide', () => {
    const build = readFileSync(join(__dirname, '../../scripts/build-client.ts'), 'utf8');
    const islands = [
      ...(/const ISLANDS = \[([^\]]*)\]/.exec(build)?.[1] ?? '').matchAll(/'([^']+)'/g),
    ].map((m) => m[1]);
    const sheets = [...build.matchAll(/STYLES\.push\(\['([^']+)'/g)].map((m) => m[1]);

    expect(islands.length).toBeGreaterThan(0);
    expect(sheets.length).toBeGreaterThan(0);
    expect(islands.filter((name) => sheets.includes(name))).toEqual([]);
    expect(sheets.filter((name) => !name.startsWith('sheet-'))).toEqual([]);
  });
});

describe('the admin stylesheet', () => {
  it('keeps the index bar’s filter on one line', () => {
    expect(declarationsOf('.spr-index-bar .spr-filter')).toMatch(/flex-wrap:\s*nowrap/);
    expect(declarationsOf('.spr-index-bar')).toMatch(/flex-wrap:\s*wrap/);
    expect(declarationsOf('.spr-index-bar')).toMatch(/align-items:\s*center/);
  });

  it('stacks the tiles that are pages, and keeps the grid for the ones that are members', () => {
    expect(declarationsOf('.spr-tiles')).toMatch(/grid-template-columns:\s*repeat\(auto-fill/);
    expect(declarationsOf('.spr-tiles-stacked')).toMatch(/grid-template-columns:\s*1fr/);
    expect(declarationsOf('.spr-tile h4')).toMatch(/font-family:\s*var\(--spr-font-mono\)/);
    expect(declarationsOf('.spr-tile-page h4')).toMatch(/font-family:\s*inherit/);
  });

  it('gives a card a heading face by what its title is, defaulting the other way', () => {
    expect(declarationsOf('.spr-card > header h4')).not.toMatch(/font-family/);
    expect(declarationsOf('.spr-card-key > header h4')).toMatch(
      /font-family:\s*var\(--spr-font-mono\)/,
    );
  });

  it('puts a card\u2019s sentence under its title rather than beside it', () => {
    expect(declarationsOf('.spr-card > header')).toMatch(/display:\s*grid/);
    expect(declarationsOf('.spr-card > header h4')).toMatch(/grid-area:\s*1\s*\/\s*1/);
    expect(declarationsOf('.spr-card > header .spr-remove')).toMatch(/grid-area:\s*1\s*\/\s*2/);
    expect(declarationsOf('.spr-card > header .spr-card-sub')).toMatch(
      /grid-area:\s*2\s*\/\s*1\s*\/\s*auto\s*\/\s*-1/,
    );
    expect(declarationsOf('.spr-card-sub')).not.toMatch(/grid-area/);
  });

  it('lets a link in a tile subtitle out from under the stretched card link', () => {
    const inner = declarationsOf('.spr-tile .spr-card-sub a');
    expect(inner).toMatch(/position:\s*relative/);
    expect(inner).toMatch(/z-index:\s*1/);

    expect(ruleFor(DASHBOARD_RULES, '.spr-tile h4 a')).not.toMatch(/z-index/);
  });

  it('starts a page index closer to its own sentence than a page of controls', () => {
    const head = ruleFor(DASHBOARD_RULES, '.spr-main > h1 + .spr-section-blurb');
    expect(head).toMatch(/margin-block-end:\s*var\(--spr-space-8\)/);

    const index = ruleFor(
      DASHBOARD_RULES,
      '.spr-main:has(.spr-tiles-stacked) > h1 + .spr-section-blurb',
    );
    expect(index).toMatch(/margin-block-end:\s*var\(--spr-space-6\)/);
    expect(index).not.toMatch(/--spr-space-8/);
  });

  it('leaves more room under a group of tiles than over it', () => {
    const tiles = ruleFor(DASHBOARD_RULES, '.spr-tiles');
    expect(tiles).toMatch(/margin-block-start:\s*var\(--spr-space-5\)/);
    expect(tiles).toMatch(/margin-block-end:\s*var\(--spr-space-7\)/);
    expect(tiles).not.toMatch(/margin:/);
  });

  it('centres a mark on the line rather than baselining it', () => {
    const block = /\.spr-entries \.spr-icon,[^{}]*\{([^}]*)\}/.exec(DASHBOARD_RULES)?.[1] ?? '';
    expect(block).toMatch(/align-self:\s*center/);
    expect(declarationsOf('.spr-entries tbody th > .spr-entry-name')).toMatch(
      /align-items:\s*baseline/,
    );
    expect(declarationsOf('.spr-lines li')).toMatch(/align-items:\s*baseline/);
  });

  it('gives every inline icon a size, because the markup carries none', () => {
    const unsized = [...DASHBOARD_RULES.matchAll(/([^{}]*\.spr-icon[^{}]*)\{([^}]*)\}/g)]
      .filter(([, , body]) => !/\b(width|height|inline-size|block-size|font-size)\s*:/.test(body))
      .map(([, selector]) => selector.trim());
    expect(unsized).toEqual([]);
  });

  it('is the big one, so the shared checks above are looking at real breadth', () => {
    const classes = [...DASHBOARD_RULES.matchAll(/\.([a-z][a-z0-9-]*)/gi)].map((m) => m[1]);
    expect(new Set(classes).size).toBeGreaterThan(8);
  });

  it('gives every operational page the same width', () => {
    const reader = /padding-inline:([^;]*);/.exec(declarationsOfBase('.spr-main'))?.[1]?.trim();
    const admin = /padding-inline:([^;]*);/
      .exec(declarationsOf('.spr-pane > .spr-main'))?.[1]
      ?.trim();
    expect(reader).toContain('--spr-measure');
    expect(admin).toBe(reader?.replace('--spr-measure', '--spr-measure-wide'));
  });

  // The reader's reserved related-column track is keyed on a shell attribute
  // the dashboard never sets; the one time it was keyed on content, every
  // settings page moved. The admin sheet must not come to know the attribute.
  it('never takes the reader\u2019s article grid', () => {
    expect(DASHBOARD).not.toContain('data-article');
    expect(DASHBOARD_RULES).not.toMatch(/\.spr-article\b/);
  });

  it('groups a page head by its spacing, not by a box', () => {
    const rem = (token: string): number =>
      Number(new RegExp(`${token}:\\s*([0-9.]+)rem`).exec(SOURCE)?.[1]);
    const blockFor = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`${escaped}[^{}]*\\{([^}]*)\\}`).exec(DASHBOARD_RULES)?.[1] ?? '';
    };
    const spaceIn = (declarations: string): number => {
      const token = /margin-block-end:\s*var\((--spr-space-[0-9]+)\)/.exec(declarations)?.[1];
      return token === undefined ? NaN : rem(token);
    };

    for (const lead of ['.spr-empty', '.spr-section-blurb']) {
      const title = spaceIn(blockFor(`.spr-main > h1:has(+ ${lead})`));
      const under = spaceIn(blockFor(`.spr-main > h1 + ${lead}`));
      expect(Number.isFinite(title)).toBe(true);
      expect(Number.isFinite(under)).toBe(true);
      expect(title).toBeLessThan(under);

      expect(spaceIn(blockFor('.spr-main > h1'))).toBe(under);

      for (const rule of [`.spr-main > h1:has(+ ${lead})`, `.spr-main > h1 + ${lead}`]) {
        expect(DASHBOARD_RULES).toContain(rule.replace('> h1', '> .spr-page-head'));
      }
      expect(spaceIn(blockFor('.spr-main > .spr-page-head'))).toBe(under);
    }
  });

  it('never lays the form out in more than two columns', () => {
    const fields = declarationsOf('.spr-fields');
    const rem = (value: string | undefined): number => Number(value?.replace('rem', ''));

    const min = rem(/minmax\(([0-9.]+rem)/.exec(fields)?.[1]);
    const cap = rem(/max-inline-size:\s*([0-9.]+rem)/.exec(fields)?.[1]);
    const gapToken = /gap:[^;]*?(--spr-space-[0-9]+)\)\s*;/.exec(fields)?.[1] as string;
    const gap = rem(new RegExp(`${gapToken}:\\s*([0-9.]+rem)`).exec(SOURCE)?.[1]);

    for (const value of [min, cap, gap]) expect(Number.isFinite(value)).toBe(true);

    const columns = Math.floor((cap + gap) / (min + gap));
    expect(columns).toBe(2);
  });

  it('gives the gallery the page rather than the form, and that is what buys the fourth card', () => {
    const rem = (value: string | undefined): number => Number(value?.replace('rem', ''));
    const tokenRem = (token: string): number =>
      rem(new RegExp(`${token}:\\s*([0-9.]+rem)`).exec(SOURCE)?.[1]);

    expect(declarationsOf('.spr-fields.spr-fields-wide')).toMatch(/max-inline-size:\s*none/);

    const gallery = declarationsOf('.spr-choices.spr-templates');
    const min = rem(/minmax\(([0-9.]+rem)/.exec(gallery)?.[1]);
    const gap = tokenRem(/gap:\s*var\((--spr-space-[0-9]+)\)/.exec(gallery)?.[1] as string);
    const page = rem(
      /--spr-measure-wide\)\)/.test(declarationsOf('.spr-pane > .spr-main'))
        ? /--spr-measure-wide:\s*([0-9.]+rem)/.exec(SOURCE)?.[1]
        : undefined,
    );

    for (const value of [min, gap, page]) expect(Number.isFinite(value)).toBe(true);
    expect(Math.floor((page + gap) / (min + gap))).toBe(4);

    const capped = rem(/max-inline-size:\s*([0-9.]+rem)/.exec(declarationsOf('.spr-fields'))?.[1]);
    expect(Math.floor((capped + gap) / (min + gap))).toBe(3);
  });

  it('takes the control cap off at exactly the width the second column goes', () => {
    const fields = declarationsOf('.spr-fields');
    expect(fields).toMatch(/container-type:\s*inline-size/);

    const rem = (value: string | undefined): number => Number(value?.replace('rem', ''));
    const min = rem(/minmax\(([0-9.]+rem)/.exec(fields)?.[1]);
    const gapToken = /gap:[^;]*?(--spr-space-[0-9]+)\)\s*;/.exec(fields)?.[1] as string;
    const gap = rem(new RegExp(`${gapToken}:\\s*([0-9.]+rem)`).exec(SOURCE)?.[1]);

    const breakpoint = rem(/@container \(width < ([0-9.]+rem)\)/.exec(DASHBOARD_RULES)?.[1]);
    expect(Number.isFinite(breakpoint)).toBe(true);
    expect(breakpoint).toBe(2 * min + gap);

    const uncapped = /@container[^{]*\{([\s\S]*?)\n {2}\}/.exec(DASHBOARD_RULES)?.[1] ?? '';
    expect(uncapped).toMatch(/max-inline-size:\s*none/);
    for (const control of ['.spr-field input:not(', '.spr-select']) {
      expect(uncapped).toContain(control);
    }
  });

  it('starts a run of a different kind of control on a fresh row', () => {
    const rule = declarationsOf('.spr-field-break');
    expect(rule).toMatch(/grid-column-start:\s*1/);
    expect(rule).not.toMatch(/grid-column:/);
  });

  it('lets a field be as tall as its own content', () => {
    expect(declarationsOf('.spr-fields')).toMatch(/align-items:\s*start/);
  });

  it('centres a switch on the box of the field beside it, not on its label and box', () => {
    const rule = declarationsOf('.spr-fields > .spr-field-boolean');
    expect(rule).toMatch(/align-self:\s*end/);
    expect(rule).toMatch(/justify-content:\s*center/);
    expect(rule).toMatch(/min-block-size:\s*calc\(/);
  });

  it('does not widen the reading measure to do it', () => {
    expect(DASHBOARD_RULES).not.toMatch(/--spr-measure\s*:/);
    for (const selector of ['.spr-help', '.spr-section-blurb', '.spr-empty']) {
      expect(declarationsOf(selector)).toMatch(/max-width:\s*var\(--spr-measure\)/);
    }
  });
});

describe('the search box over the column', () => {
  it('gives up the header box’s minimum width, which the column has not got', () => {
    const box = declarationsOf(".spr-nav-search input[type='search']");
    expect(box).toMatch(/min-inline-size:\s*0/);
    expect(box).toMatch(/inline-size:\s*100%/);
    expect(declarationsOf('.spr-nav-search .spr-input-icon')).toMatch(/flex:\s*1 1 auto/);
  });

  it('marks where a result lands, and marks the field rather than the box', () => {
    expect(DASHBOARD_RULES).toMatch(/\.spr-field:has\(:target\)\s*\{/);
    expect(declarationsOf('.spr-field:has(:target)')).toMatch(/outline:/);
    expect(DASHBOARD_RULES).not.toMatch(/\.spr-field:has\(:focus\)\s*\{/);
  });
});

describe('the saved toast', () => {
  const TOAST = declarationsOf('.spr-toast');

  it('takes no space in the form it reports on', () => {
    expect(TOAST).toMatch(/position:\s*fixed/);
  });

  it('is the status colour, not a tint of it', () => {
    expect(TOAST).toMatch(/background:\s*var\(--spr-status-accent\)/);
    expect(TOAST).toMatch(/color:\s*var\(--spr-bg\)/);
  });

  it('removes itself, with no script to do it', () => {
    expect(TOAST).toMatch(/animation:[^;]*\bforwards\b/);
    for (const name of ['spr-toast', 'spr-toast-still']) {
      const frames =
        new RegExp(`@keyframes ${name}\\s*\\{[\\s\\S]*?\\n {2}\\}`).exec(DASHBOARD)?.[0] ?? '';
      expect(frames).not.toBe('');
      expect(/to\s*\{[^}]*visibility:\s*hidden/.test(frames)).toBe(true);
    }
  });

  it('can be taken away by hand, with no script to do that either', () => {
    const cross = declarationsOf('.spr-toast-dismiss');
    expect(cross).toMatch(/appearance:\s*none/);
    expect(declarationsOf('.spr-toast-dismiss::before')).toMatch(/content:/);
    expect(declarationsOf('.spr-toast-dismiss:focus-visible')).toMatch(/outline:/);

    expect(declarationsOf('.spr-toast:has(.spr-toast-dismiss:checked)')).toMatch(/display:\s*none/);
  });

  it('gives the cross a target bigger than its mark, and the toast pays nothing', () => {
    const cross = declarationsOf('.spr-toast-dismiss');
    const em = (property: string) =>
      Number.parseFloat(
        new RegExp(`(?:^|;)\\s*${property}:\\s*(-?[\\d.]+)em`).exec(cross)?.[1] ?? 'NaN',
      );

    const size = em('inline-size');
    const pull = em('margin');
    expect(em('block-size')).toBe(size);

    expect(size).toBeGreaterThanOrEqual(2.25);

    expect(pull).toBeLessThan(0);
    expect(size + 2 * pull).toBeCloseTo(1.5);

    expect(cross).toMatch(/padding:\s*0/);
  });

  it('draws the cross in its own text colour, not in a token for the page', () => {
    expect(declarationsOf('.spr-toast-dismiss')).toMatch(/color:\s*inherit/);
    expect(declarationsOf('.spr-toast-dismiss:focus-visible')).toMatch(/outline:[^;]*currentcolor/);
  });

  it('still goes away for a reader who asked for less motion', () => {
    const reduced =
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.spr-toast\s*\{([^}]*)\}/.exec(
        DASHBOARD_RULES,
      )?.[1];
    expect(reduced).toMatch(/animation-name:\s*spr-toast-still/);
    expect(reduced).not.toMatch(/animation:\s*none/);
  });

  it('keeps clear of the save bar that shares its corner', () => {
    const [selector, body] = rulesNaming('spr-toast').find(([s]) => s.includes('.spr-config')) ?? [
      '',
      '',
    ];
    expect(selector).toContain(':has(.spr-config:not([data-spr-live]))');
    expect(body).toMatch(/inset-block-end/);
    // Raised only without scripting, so it does not drop once the island arrives
    expect(DASHBOARD).toMatch(
      /@media \(scripting: none\)\s*\{\s*\.spr-main:has\(\.spr-config:not\(\[data-spr-live\]\)\) \.spr-toast/,
    );

    const bar = declarationsOf('.spr-config[data-spr-live][data-spr-pending] .spr-config-actions');
    expect(Number(/z-index:\s*(\d+)/.exec(TOAST)?.[1])).toBeGreaterThan(
      Number(/z-index:\s*(\d+)/.exec(bar)?.[1]),
    );
  });
});

describe('the save bar without the island', () => {
  it('waits a moment before showing where the island will replace it', () => {
    const scripted =
      /@media \(scripting: enabled\)\s*\{([\s\S]*?)\n {2}\}/.exec(DASHBOARD)?.[1] ?? '';
    expect(scripted).toContain('.spr-config:not([data-spr-live]) .spr-config-actions');
    expect(scripted).toMatch(/animation:\s*spr-config-bar-wait 0s \d+(\.\d+)?s both/);

    const frames = /@keyframes spr-config-bar-wait\s*\{([\s\S]*?)\n {2}\}/.exec(DASHBOARD)?.[1];
    expect(frames).toMatch(/from\s*\{\s*visibility:\s*hidden/);
    expect(frames).toMatch(/to\s*\{\s*visibility:\s*visible/);
  });
});

const FORCED_COLORS = [
  ...DASHBOARD_RULES.matchAll(/@media \(forced-colors: active\)\s*\{([\s\S]*?)\n {2}\}/g),
]
  .map((m) => m[1])
  .join('\n');

function rulesNaming(name: string): [string, string][] {
  return [...DASHBOARD_RULES.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => selector.includes(name))
    .map(([, selector, body]) => [selector.replace(/\s+/g, ' ').trim(), body]);
}

describe('the form controls', () => {
  it('styles every box a value is typed into, whatever type it has', () => {
    const rules = DASHBOARD_RULES.match(/\.spr-field input[^{,]*/g) ?? [];
    expect(rules.length).toBeGreaterThan(1);
    for (const selector of rules) {
      if (selector.includes('checkbox]')) continue;
      expect(selector).toContain(':not(');
      expect(selector).not.toMatch(/input\[type='(text|password|number)'\]/);
    }
  });

  it('leaves a card with no display of its own, so `hidden` folds it', () => {
    const card = declarationsOf('.spr-card');
    expect(card).not.toBe('');
    if (/\bdisplay\s*:/.test(card)) {
      expect(declarationsOf('.spr-card[hidden]')).toMatch(/display:\s*none/);
    }
  });
});

describe('a value with a unit', () => {
  it('puts the box round the pair and takes it off the halves', () => {
    const group = declarationsOf('.spr-unit');
    expect(group).toMatch(/border:\s*var\(--spr-border\)/);
    expect(group).toMatch(/border-radius:\s*var\(--spr-radius\)/);
    expect(group).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto/);

    const halves = declarationsOf('.spr-field .spr-unit > input');
    expect(halves).toMatch(/border:\s*0/);
    expect(halves).toMatch(/background:\s*transparent/);
    expect(halves).not.toMatch(/padding|font-/);
  });

  it('rings the pair rather than the half that has focus', () => {
    expect(declarationsOf('.spr-unit:focus-within')).toMatch(
      /outline:\s*2px solid var\(--spr-accent\)/,
    );
    expect(declarationsOf('.spr-field .spr-unit > input:focus-visible')).toMatch(/outline:\s*none/);
  });

  it('is capped and uncapped with every other control', () => {
    for (const rules of [
      DASHBOARD_RULES,
      /@container[^{]*\{([\s\S]*?)\n {2}\}/.exec(DASHBOARD_RULES)?.[1] ?? '',
    ]) {
      expect(rules).toContain('.spr-field .spr-unit');
    }
  });
});

describe('a colour and its swatch', () => {
  it('leaves the box exactly the box every other control is', () => {
    const boxes = DASHBOARD_RULES.match(/\.spr-field input:not\([^)]*\)/g) ?? [];
    expect(boxes.length).toBeGreaterThan(0);
    for (const selector of boxes) expect(selector).toContain("[type='color']");
  });

  it('sizes the square from the scale, not from a number of its own', () => {
    const square = declarationsOf(".spr-swatch > input[type='color']");
    expect(square).toMatch(/inline-size:\s*var\(--spr-space-\d\)/);
    expect(square).toMatch(/block-size:\s*var\(--spr-space-\d\)/);
    expect(square).toMatch(/padding:\s*0/);
  });

  it('is capped and uncapped with every other control', () => {
    for (const rules of [
      DASHBOARD_RULES,
      /@container[^{]*\{([\s\S]*?)\n {2}\}/.exec(DASHBOARD_RULES)?.[1] ?? '',
    ]) {
      expect(rules).toContain('.spr-field .spr-swatch');
    }
  });
});

describe('the end of the header', () => {
  it('sends the account control to the far end whether or not there is a search box', () => {
    const group = declarationsOfBase('.spr-account');
    expect(group).toMatch(/margin-left:\s*auto/);
    expect(declarationsOfBase('.spr-signin')).toMatch(/margin-left:\s*auto/);
    expect(declarationsOfBase('.spr-search')).toMatch(/margin-left:\s*auto/);
  });

  it('gives it back where the search box is already holding it', () => {
    expect(ruleFor(RULES, '.spr-search ~ .spr-account')).toMatch(/margin-left:\s*0/);
    expect(ruleFor(RULES, '.spr-search ~ .spr-signin')).toMatch(/margin-left:\s*0/);
  });

  it('clips the address to one line, and gives the menu the width to clip it against', () => {
    const menu = declarationsOfBase('.spr-account-menu');
    expect(menu).toMatch(/max-width:\s*min\(var\(--spr-menu-max-width\),\s*calc\(100vw/);

    const address = declarationsOfBase('.spr-account-who span');
    expect(address).toMatch(/white-space:\s*nowrap/);
    expect(address).toMatch(/text-overflow:\s*ellipsis/);
    expect(address).toMatch(/overflow:\s*hidden/);
  });

  it('lays a menu item out as a row and sizes the mark on it', () => {
    const item = declarationsOfBase('.spr-account-item');
    expect(item).toMatch(/display:\s*flex/);
    expect(item).toMatch(/align-items:\s*center/);
    expect(item).toMatch(/gap:\s*var\(--spr-space-/);

    const mark = declarationsOfBase('.spr-account-item > .spr-icon');
    expect(mark).toMatch(/width:\s*1em/);
    expect(mark).toMatch(/height:\s*1em/);
    expect(mark).toMatch(/margin:\s*0/);
  });
});

describe('an input with an icon', () => {
  it('is described once, where every surface can see it', () => {
    expect(declarationsOfBase('.spr-input-icon')).not.toBe('');
    expect(DASHBOARD_RULES).not.toMatch(/(^|\})\s*\.spr-input-icon\s*\{/);
  });

  it('leaves the box its own styling and only makes room for the mark', () => {
    const wrapper = declarationsOfBase('.spr-input-icon');
    expect(wrapper).toMatch(/position:\s*relative/);
    expect(wrapper).not.toMatch(/border|background/);

    expect(wrapper).toMatch(/--spr-input-lead:\s*calc\(/);
    expect(SOURCE).toMatch(/padding-inline-start:\s*var\(--spr-input-lead\)/);

    const box = declarationsOfBase('.spr-input-icon > input');
    expect(box).not.toMatch(/border|background|padding/);
  });

  it('draws the mark from the icon set, and lets clicks through it', () => {
    const mark = declarationsOfBase('.spr-input-icon > .spr-icon');
    expect(mark).toMatch(/position:\s*absolute/);
    expect(mark).toMatch(/inset-inline-start:/);
    expect(mark).toMatch(/pointer-events:\s*none/);
    expect(mark).toMatch(/width:\s*1em/);
    expect(mark).toMatch(/margin:\s*0/);
  });
});

describe('the modal', () => {
  it('is centred on the viewport, in both axes and by one arrangement', () => {
    const panel = declarationsOf('.spr-modal-panel');
    expect(panel).toMatch(/position:\s*fixed/);
    expect(panel).toMatch(/inset:\s*0/);
    expect(panel).toMatch(/margin:\s*auto/);
    expect(panel).toMatch(/height:\s*fit-content/);
    expect(panel).toMatch(/width:\s*min\(/);
    expect(panel).toMatch(/max-height:/);
    expect(panel).toMatch(/overflow:\s*auto/);
  });

  it('draws its backdrop from the control that closes it', () => {
    const backdrop = declarationsOf('.spr-modal[open] > summary::after');
    expect(backdrop).toMatch(/position:\s*fixed/);
    expect(backdrop).toMatch(/inset:\s*0/);
    expect(backdrop).toMatch(/color-mix\(in srgb, var\(--spr-bg\)/);
  });

  it('puts the action at the trailing edge, where the reader leaves the panel', () => {
    const actions = declarationsOf('.spr-modal-actions');
    expect(actions).toMatch(/justify-self:\s*stretch/);
    expect(actions).toMatch(/justify-content:\s*flex-end/);
  });

  it('puts the panel above the backdrop', () => {
    const layer = (declarations: string) => Number(/z-index:\s*([0-9]+)/.exec(declarations)?.[1]);
    expect(layer(declarationsOf('.spr-modal-panel'))).toBeGreaterThan(
      layer(declarationsOf('.spr-modal[open] > summary::after')),
    );
  });
});

function declarationsOfBase(selector: string): string {
  return ruleFor(RULES, selector);
}

function ruleFor(rules: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alone = new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(rules);
  if (alone) return alone[2];

  const inList = `(^|\\})\\s*(?:[^{}]*,\\s*)?${escaped}\\s*(?:,\\s*[^{}]*)?\\{([^}]*)\\}`;
  return new RegExp(inList, 'm').exec(rules)?.[2] ?? '';
}

function rulePreludes(rules: string): Array<[string, string]> {
  return [...rules.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((rule) => [rule[1].trim(), rule[2]]);
}

function weightOf(selector: string): [number, number] {
  return [
    (selector.match(/\.[a-z0-9-]+/gi) ?? []).length,
    (selector.match(/(^|\s)[a-z]+/gi) ?? []).length,
  ];
}

function declarationsOf(selector: string): string {
  return ruleFor(DASHBOARD_RULES, selector);
}

describe('the template gallery', () => {
  it('gives the legend the whole row', () => {
    expect(declarationsOf('.spr-choices.spr-templates')).toMatch(/display:\s*grid/);
    expect(declarationsOf('.spr-choices.spr-templates > legend')).toMatch(/grid-column:\s*1 \/ -1/);
  });

  it('outweighs the fieldset rule it corrects, whatever order the import puts them in', () => {
    const grid = rulePreludes(DASHBOARD_RULES).find(
      ([selector, body]) => selector.includes('.spr-templates') && /display:\s*grid/.test(body),
    );
    expect(grid).toBeDefined();
    const [gridSelector] = grid!;
    const [gridClasses] = weightOf(gridSelector);
    for (const [selector, body] of rulePreludes(DASHBOARD_RULES)) {
      if (!/display:/.test(body)) continue;
      for (const one of selector.split(',').map((s) => s.trim())) {
        if (one !== '.spr-choices') continue;
        expect(gridClasses).toBeGreaterThan(weightOf(one)[0]);
      }
    }
    expect(declarationsOf('.spr-choices')).toMatch(/display:\s*flex/);
  });

  it('stretches the children of a card, so the frame has a width at all', () => {
    const card = declarationsOf('.spr-templates .spr-template');
    expect(card).toMatch(/flex-direction:\s*column/);
    expect(card).toMatch(/align-items:\s*stretch/);
  });

  it('gives the frame a height of its own', () => {
    const frame = declarationsOf('.spr-template-frame');
    expect(frame).toMatch(/aspect-ratio:/);
    expect(frame).toMatch(/overflow:\s*hidden/);
  });

  it('scales the frame by the same number it sizes it with', () => {
    const frame = declarationsOf('.spr-template-frame > iframe');
    const scale = /transform:\s*scale\(([0-9.]+)\)/.exec(frame)?.[1];
    expect(scale).toBeDefined();
    expect(frame).toContain(`inline-size: calc(100% / ${scale})`);
    expect(frame).toContain(`block-size: calc(100% / ${scale})`);
    const track = /minmax\(([0-9.]+)rem/.exec(declarationsOf('.spr-choices.spr-templates'))?.[1];
    expect(track).toBeDefined();
    const chrome = 2 * 0.6 + 2 * 0.0625;
    expect((Number(track) - chrome) / Number(scale)).toBeGreaterThan(48);
  });
});

describe('a disabled button', () => {
  it('is one rule for every button on the surface', () => {
    const disabled = declarationsOf('button:disabled');
    expect(disabled).toMatch(/background:\s*var\(--spr-surface\)/);
    expect(disabled).toMatch(/color:\s*var\(--spr-muted\)/);
    expect(disabled).toMatch(/opacity:\s*0?\.\d+/);
    expect(disabled).toMatch(/cursor:\s*not-allowed/);
    expect(
      rulesNaming('button:disabled').filter(([selector]) => selector.endsWith(':disabled')),
    ).toHaveLength(1);
  });

  it('does not light up under the pointer', () => {
    expect(declarationsOf('button:disabled:hover')).toMatch(/border-color:\s*var\(--spr-line\)/);
    const hovers = ['.spr-add button:hover', '.spr-modal-actions button:hover'];
    for (const hover of hovers) {
      expect(DASHBOARD_RULES.indexOf('button:disabled:hover')).toBeGreaterThan(
        DASHBOARD_RULES.indexOf(hover),
      );
    }
  });
});

describe('the remove button', () => {
  it('is a row, so its bin sits on the button’s centre line', () => {
    const button = rulesNaming('.spr-remove')
      .map(([, body]) => body)
      .join('\n');
    expect(button).toMatch(/display:\s*inline-flex/);
    expect(button).toMatch(/align-items:\s*center/);
    expect(button).toMatch(/gap:\s*var\(--spr-space-/);
  });

  it('sizes the bin against the button’s own type', () => {
    expect(declarationsOf('.spr-remove > .spr-icon')).toMatch(/inline-size:\s*[\d.]+em/);
  });
});

describe('the dropdown that is not a select', () => {
  it('draws its chevron exactly as the select wrapper draws one', () => {
    const select = rulesNaming('.spr-select::after')
      .map(([, body]) => body)
      .join('\n');
    const summary = declarationsOf('.spr-dropdown > summary::after');
    for (const ink of [/border-width:\s*0 0\.1em 0\.1em 0/, /rotate:\s*45deg/, /content:\s*''/]) {
      expect(select).toMatch(ink);
      expect(summary).toMatch(ink);
    }
    expect(declarationsOf('.spr-dropdown[open] > summary::after')).toMatch(/rotate:\s*225deg/);
  });

  it('undresses a dropdown row of the panel label it happens to be', () => {
    const exempt = rulesNaming('.spr-dd-row')
      .filter(([selector]) => selector.includes('spr-modal-panel'))
      .map(([, body]) => body)
      .join('\n');
    expect(exempt).toMatch(/text-transform:\s*none/);
    expect(exempt).toMatch(/font-size:\s*var\(--spr-font-size\)/);
    expect(exempt).toMatch(/color:\s*var\(--spr-fg\)/);
  });

  it('shows the checked row when shut, naming no position, so no list is too long', () => {
    expect(DASHBOARD_RULES).not.toMatch(/\.spr-dropdown[^{]*nth-of-type/);
    expect(
      declarationsOf(
        '.spr-dropdown:not([open]) > .spr-dd-list > .spr-dd-row:not(:has(> input:checked))',
      ),
    ).toMatch(/display:\s*none/);
    expect(declarationsOf('.spr-dropdown:not([open])::details-content')).toMatch(
      /content-visibility:\s*visible/,
    );
    expect(declarationsOf('.spr-dropdown:not([open]):has(> summary:focus-visible)')).toMatch(
      /outline:\s*2px solid var\(--spr-accent\)/,
    );
  });

  it('keeps the operated control reachable, and puts its ring on the row', () => {
    expect(declarationsOf('.spr-dd-row:has(> input:focus-visible)')).toMatch(/outline:/);
    const tick = declarationsOf('.spr-dd-row:has(> input:checked)::after');
    expect(tick).toMatch(/content:\s*''/);
    expect(tick).toMatch(/border-color:\s*var\(--spr-accent\)/);
  });

  it('shows an answer’s note only while that answer is the one chosen', () => {
    const note = declarationsOf('.spr-choices > .spr-choice-note');
    expect(note).toMatch(/display:\s*none/);
    expect(
      declarationsOf('.spr-choices:has(input[data-spr-unavailable]:checked) > .spr-choice-note'),
    ).toMatch(/display:\s*block/);
    expect(note).toMatch(/flex:\s*1 1 100%/);
    expect(note).toMatch(/font-size:\s*var\(--spr-font-size-small\)/);
    expect(DASHBOARD_RULES).not.toContain('magic-link');
  });

  it('takes the width of the row and of the panel it is in', () => {
    expect(declarationsOf('.spr-choices > .spr-dropdown')).toMatch(/flex:\s*1 1 100%/);
    expect(declarationsOf('.spr-modal-panel .spr-choices')).toMatch(/justify-self:\s*stretch/);
  });

  it('opens over the modal it is in, rather than inside its scrollbar', () => {
    expect(declarationsOf('.spr-modal-panel:has(.spr-dropdown[open])')).toMatch(
      /overflow:\s*visible/,
    );
    expect(declarationsOf('.spr-modal-panel')).toMatch(/position:\s*fixed/);
  });

  it('scrolls its panel rather than growing without end', () => {
    const list = declarationsOf('.spr-dd-list');
    expect(list).toMatch(/position:\s*absolute/);
    expect(list).toMatch(/max-block-size:/);
    expect(list).toMatch(/overflow:\s*auto/);
  });
});

describe('a choice named by a mark', () => {
  it('sizes the mark, because the markup states a pixel size for another context', () => {
    const mark = declarationsOf('.spr-choices label > .spr-icon');
    expect(mark).toMatch(/width:\s*[\d.]+em/);
    expect(mark).toMatch(/flex:\s*none/);
  });

  it('keeps a panel’s choices from being dressed as its labels', () => {
    const rows = declarationsOf('.spr-modal-panel .spr-choices label');
    expect(rows).toMatch(/text-transform:\s*none/);
    expect(rows).toMatch(/color:\s*var\(--spr-fg\)/);
    expect(DASHBOARD_RULES.indexOf('.spr-modal-panel .spr-choices label')).toBeGreaterThan(
      DASHBOARD_RULES.indexOf('.spr-choices label {'),
    );
  });
});

describe('the switch', () => {
  const TRACK = declarationsOf(".spr-switch > input[type='checkbox']");
  const KNOB = declarationsOf(".spr-switch > input[type='checkbox']::before");
  const ON = declarationsOf(".spr-switch > input[type='checkbox']:checked::before");

  it('replaces the platform control rather than decorating it', () => {
    expect(TRACK).toMatch(/appearance:\s*none/);
    expect(KNOB).toMatch(/content:\s*''/);
  });

  it('moves the knob exactly the length of the track it is not', () => {
    const size = (declarations: string, property: string) =>
      Number.parseFloat(new RegExp(`${property}:\\s*([\\d.]+)em`).exec(declarations)?.[1] ?? 'NaN');

    const width = size(TRACK, 'inline-size');
    const height = size(TRACK, 'block-size');
    const travel = Number.parseFloat(/translate:\s*([\d.]+)em/.exec(ON)?.[1] ?? 'NaN');

    expect(travel).toBeCloseTo(width - height);
  });

  it('keeps its position when it is disabled', () => {
    const disabled = declarationsOf(".spr-switch > input[type='checkbox']:disabled");
    expect(disabled).toMatch(/opacity/);
    expect(disabled).not.toMatch(/background/);
    expect(declarationsOf(".spr-switch > input[type='checkbox']:checked")).toMatch(
      /background:\s*var\(--spr-accent\)/,
    );
  });

  it('carries its own focus ring', () => {
    expect(declarationsOf(".spr-switch > input[type='checkbox']:focus-visible")).toMatch(
      /outline:/,
    );
  });

  it('is never dressed as the question above a control', () => {
    const reaching = rulePreludes(DASHBOARD_RULES)
      .filter(
        ([prelude, declarations]) =>
          prelude.includes('.spr-field') && /text-transform:\s*uppercase/.test(declarations),
      )
      .flatMap(([prelude]) => prelude.split(','))
      .map((selector) => selector.trim())
      .filter((selector) => /(^|\s|>)label\b/.test(selector))
      .filter((selector) => !selector.includes(':not(.spr-switch)'));
    expect(reaching).toEqual([]);

    expect(weightOf('.spr-field > label')[0]).toBe(weightOf('.spr-switch')[0]);
    expect(weightOf('.spr-field > label')[1]).toBeGreaterThan(weightOf('.spr-switch')[1]);
  });

  it('stays two states under forced colours', () => {
    expect(FORCED_COLORS).toContain(".spr-switch > input[type='checkbox']:checked");
    expect(FORCED_COLORS).toMatch(/Highlight/);
  });
});

describe('the checkbox', () => {
  const BOX = declarationsOf(".spr-choices label > input[type='checkbox']");
  const ROW_BOX = ".spr-rows .spr-select-col input[type='checkbox']";
  const TICK = declarationsOf(".spr-choices label > input[type='checkbox']::before");

  it('replaces the platform control rather than decorating it', () => {
    expect(BOX).toMatch(/appearance:\s*none/);
  });

  it('draws the tick instead of typing it', () => {
    expect(TICK).toMatch(/content:\s*''/);
    expect(TICK).toMatch(/border-width:[^;]*em/);
    expect(TICK).toMatch(/rotate:/);
  });

  it('keeps the mark the same weight at any size', () => {
    for (const property of ['inline-size', 'block-size']) {
      expect(new RegExp(`${property}:\\s*[\\d.]+em`).test(BOX)).toBe(true);
    }
    expect(TICK).not.toMatch(/border-width:[^;]*px/);
  });

  it('is square where the switch is a pill', () => {
    const radiusOf = (declarations: string) =>
      /border-radius:([^;]*);/.exec(declarations)?.[1]?.trim();
    expect(radiusOf(BOX)).toBe('var(--spr-radius-sm)');
    expect(radiusOf(declarationsOf(".spr-switch > input[type='checkbox']"))).not.toBe(
      radiusOf(BOX),
    );
  });

  it('centres a row’s cells against each other, and sizes the box by its font', () => {
    expect(declarationsOf('.spr-rows tbody td')).toMatch(/vertical-align:\s*middle/);

    expect(DASHBOARD_RULES).toMatch(
      /\.spr-rows \.spr-select-col input\[type='checkbox'\] \{\s*font-size:\s*[0-9.]+em/,
    );
    expect(declarationsOf('.spr-rows .spr-select-col')).not.toMatch(/font-size:/);
  });

  it('tints a selected row, and leaves a hovered one alone', () => {
    const selected = declarationsOf('.spr-rows tbody tr:has(.spr-select-col input:checked)');
    expect(selected).toMatch(/color-mix\(in oklab, var\(--spr-accent\) var\(--spr-callout-tint\)/);
    expect(DASHBOARD_RULES).not.toContain('.spr-rows tbody tr:hover');
  });

  it('gives a table its own heading, not a caption that drifted upward', () => {
    const title = declarationsOf('.spr-table-title');
    expect(title).toMatch(/font-size:\s*1\.1rem/);
    expect(title).not.toMatch(/color:/);

    expect(title).not.toMatch(/margin/);

    const head = declarationsOf('.spr-table-head');
    expect(head).toMatch(/margin-block:\s*var\(--spr-space-8\) var\(--spr-space-3\)/);
    expect(declarationsOf('.spr-rows')).toMatch(
      /margin-block:\s*var\(--spr-space-2\) var\(--spr-space-6\)/,
    );
  });

  it('holds the column open with a hidden box, not a reserved width', () => {
    expect(declarationsOf('.spr-rows .spr-select-col input[data-spr-idle]')).toMatch(
      /visibility:\s*hidden/,
    );
    expect(declarationsOf('.spr-rows .spr-select-col')).not.toMatch(/min-inline-size/);
  });

  it('sets no table\u2019s headings in capitals', () => {
    expect(declarationsOfBase('.spr-table thead th')).not.toMatch(/text-transform/);
    expect(declarationsOf('.spr-rows thead th')).not.toMatch(/text-transform/);
  });

  it('paints the bulk Remove before it is hovered', () => {
    const bulk = declarationsOf('.spr-table-head .spr-remove');
    expect(bulk).toMatch(/color:\s*var\(--spr-status-fail\)/);
    expect(bulk).toMatch(/border-color:\s*var\(--spr-status-fail\)/);
  });

  it('keeps the head row as tall as the button it sometimes holds', () => {
    const head = declarationsOf('.spr-table-head');
    expect(head).toMatch(/min-block-size:\s*calc\(/);
    for (const token of ['--spr-font-size-small', '--spr-line-height', '--spr-space-2']) {
      expect(head).toContain(token);
    }
  });

  it('hides Remove selected until something is selected, without a script', () => {
    const hidden = declarationsOf(
      ".spr-table-head:not(:has(+ table input[type='checkbox']:checked)) .spr-remove",
    );
    expect(hidden).toMatch(/display:\s*none/);
  });

  it('lets a table of values space itself, and its headings wrap', () => {
    expect(declarationsOf('.spr-rows')).toMatch(/margin-block:/);
    expect(declarationsOf('.spr-rows thead th')).toMatch(/white-space:\s*normal/);
  });

  it('draws a table row’s selection box with this rule, not a second one', () => {
    expect(DASHBOARD_RULES).toMatch(
      /\.spr-choices label > input\[type='checkbox'\],\s*\.spr-rows \.spr-select-col input\[type='checkbox'\]\s*\{/,
    );
    expect(declarationsOf(`${ROW_BOX}:checked`)).toBe(
      declarationsOf(".spr-choices label > input[type='checkbox']:checked"),
    );
    expect(declarationsOf(`${ROW_BOX}::before`)).toBe(TICK);
    expect(BOX).toContain('appearance: none');

    expect(DASHBOARD_RULES).toContain(`${ROW_BOX}:checked`);
  });

  it('keeps its answer when it is disabled', () => {
    const disabled = declarationsOf(".spr-choices label > input[type='checkbox']:disabled");
    expect(disabled).toMatch(/opacity/);
    expect(disabled).not.toMatch(/background/);
    expect(declarationsOf(".spr-choices label > input[type='checkbox']:checked")).toMatch(
      /background:\s*var\(--spr-accent\)/,
    );
  });

  it('carries its own focus ring', () => {
    expect(declarationsOf(".spr-choices label > input[type='checkbox']:focus-visible")).toMatch(
      /outline:/,
    );
  });

  it('stays two states under forced colours', () => {
    expect(FORCED_COLORS).toContain(".spr-choices label > input[type='checkbox']:checked");
    expect(FORCED_COLORS).toMatch(/HighlightText/);
  });
});

describe('the radio', () => {
  const RADIO = declarationsOf(".spr-choices input[type='radio']");
  const CHECKBOX = declarationsOf(".spr-choices label > input[type='checkbox']");

  it('replaces the platform control rather than decorating it', () => {
    expect(RADIO).toMatch(/appearance:\s*none/);
  });

  it('is round where the checkbox is square, and identical otherwise', () => {
    expect(/border-radius:\s*([^;]+);/.exec(RADIO)?.[1]).toBe('50%');
    expect(/border-radius:\s*([^;]+);/.exec(CHECKBOX)?.[1]).toBe('var(--spr-radius-sm)');
    for (const property of ['inline-size', 'block-size', 'border', 'background', 'cursor']) {
      const from = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`);
      expect(from.exec(RADIO)?.[1]).toBe(from.exec(CHECKBOX)?.[1]);
    }
  });

  it('fills with the same accent the checkbox and the switch use', () => {
    const on = declarationsOf(".spr-choices input[type='radio']:checked");
    expect(on).toMatch(/background:\s*var\(--spr-accent\)/);
    expect(on).toMatch(/border-color:\s*var\(--spr-accent\)/);
    expect(declarationsOf(".spr-choices input[type='radio']::before")).toMatch(
      /background:\s*var\(--spr-bg\)/,
    );
  });

  it('reaches a radio that is not its label’s child', () => {
    expect(DASHBOARD_RULES).not.toMatch(/\.spr-choices label > input\[type='radio'\]/);
    const gallery = readFileSync(
      join(COMPONENTS, 'config-fields', 'template', 'template.eta'),
      'utf8',
    );
    expect(gallery).toMatch(/type="radio"/);
    expect(gallery).toMatch(/class="spr-choices[^"]*"/);
  });

  it('keeps its answer when it is disabled', () => {
    const disabled = declarationsOf(".spr-choices input[type='radio']:disabled");
    expect(disabled).toMatch(/opacity/);
    expect(disabled).not.toMatch(/background/);
  });

  it('carries its own focus ring', () => {
    expect(declarationsOf(".spr-choices input[type='radio']:focus-visible")).toMatch(/outline:/);
  });

  it('stays two states under forced colours', () => {
    expect(FORCED_COLORS).toContain(".spr-choices input[type='radio']:checked");
    expect(FORCED_COLORS).toMatch(/HighlightText/);
  });
});

describe('the info popover', () => {
  const NOTE = declarationsOf('.spr-info-note');
  const MARKER_HEIGHT = '1.25 * var(--spr-font-size-label)';

  it('sizes the marker the way the rest of the component assumes', () => {
    const marker = declarationsOf('.spr-info-mark');
    expect(marker).toContain(`block-size: calc(${MARKER_HEIGHT})`);
    // The "i" is a touch smaller than the label, without shrinking its circle
    expect(marker).toMatch(/font-size:\s*calc\(0\.9 \* var\(--spr-font-size-label\)\)/);
  });

  it('is not in the top layer', () => {
    expect(DASHBOARD_RULES).not.toMatch(/popover/);
  });

  it('anchors the note to its own marker', () => {
    expect(declarationsOf('.spr-info')).toMatch(/position:\s*relative/);
    expect(NOTE).toMatch(/position:\s*absolute/);
    expect(NOTE).toMatch(/inset-block-start:\s*calc\(100%/);
  });

  it('reveals it to a pointer and to a keyboard', () => {
    expect(DASHBOARD_RULES).toMatch(/\.spr-info:hover > \.spr-info-note/);
    expect(DASHBOARD_RULES).toMatch(/\.spr-info-mark:focus-visible ~ \.spr-info-note/);
  });

  it('does not let a click pin a card open', () => {
    expect(DASHBOARD_RULES).not.toMatch(/\.spr-info:focus-within/);
  });

  it('never leaves two cards on screen at once', () => {
    expect(NOTE).toMatch(/transition:\s*opacity 0s,\s*display 0s allow-discrete/);
  });

  it('stays up when the pointer moves onto it', () => {
    expect(NOTE).not.toMatch(/pointer-events/);
  });

  it('sizes the wrapper to the marker, not to the line', () => {
    const wrapper = declarationsOf('.spr-info');
    expect(wrapper).toMatch(/display:\s*inline-flex/);
    expect(wrapper).toMatch(/align-items:\s*center/);
  });

  // The caret belongs to the marker, so it stays under the marker wherever the note opens
  it('points the caret back at its marker', () => {
    const caret = declarationsOf('.spr-info-mark::after');
    expect(caret).toMatch(/content:\s*''/);
    expect(caret).toMatch(/rotate:/);
    expect(caret).toMatch(/inset-block-start:\s*calc\(100%/);
    expect(caret).toMatch(/inset-inline-start:\s*calc\(50% -/);
    expect(caret).not.toMatch(/url\(/);
  });

  it('draws the caret in the card’s own colours', () => {
    const caret = declarationsOf('.spr-info-mark::after');
    expect(/background:\s*([^;]+);/.exec(caret)?.[1]).toBe(
      /background:\s*([^;]+);/.exec(NOTE)?.[1],
    );
    const edge = /border:\s*([^;]+);/.exec(NOTE)?.[1];
    expect(caret).toContain(`border-block-start: ${edge}`);
    expect(caret).toContain(`border-inline-start: ${edge}`);
  });

  it('reaches the card by a safe area, not by luck', () => {
    const safe = declarationsOf('.spr-info-note::before');
    const gap = /inset-block-start:\s*calc\(100% \+ ([^)]+\))\)/.exec(NOTE)?.[1];
    expect(gap).toBeDefined();
    expect(safe).toMatch(/inset-block-end:\s*100%/);
    expect(safe).toContain(`calc(${gap} + var(--spr-border))`);
  });

  // The note can open to the right of the marker, centred under it or to its left
  it('spans that area across the whole card, whichever side the card opens to', () => {
    const safe = declarationsOf('.spr-info-note::before');
    expect(safe).toMatch(/inset-inline:\s*0/);
    expect(safe).not.toMatch(/clip-path/);
  });

  it('opens to the right, else centred, else to the left, where anchor positioning exists', () => {
    expect(DASHBOARD_RULES).toMatch(/position-area:\s*block-end span-inline-end/);
    expect(DASHBOARD_RULES).toMatch(
      /position-try-fallbacks:\s*block-end,\s*block-end span-inline-start/,
    );
  });

  it('keeps the cursor the marker’s where it covers the marker', () => {
    const marker = declarationsOf('.spr-info-mark');
    const cursor = /cursor:\s*([^;]+);/.exec(marker)?.[1];
    expect(cursor).toBe('help');
    expect(declarationsOf('.spr-info-note::before')).toContain(`cursor: ${cursor}`);
  });

  // A note that is only invisible still counts toward the page's overflow, so a note
  // beside the right edge would let the page scroll sideways
  it('removes the hidden note from the layout', () => {
    expect(NOTE).toMatch(/display:\s*none/);
    expect(NOTE).not.toMatch(/visibility\s*:/);
  });

  it('sheds everything its containers impose on text', () => {
    for (const property of ['white-space', 'text-transform', 'font-weight', 'letter-spacing']) {
      expect(NOTE).toContain(`${property}:`);
    }
  });

  // Its one pseudo-element is the caret, which draws no text
  it('draws the marker from its own text, not a pseudo-element', () => {
    const rules = rulesNaming('spr-info-mark');
    expect(rules.length).toBeGreaterThan(1);
    expect(rules.filter(([selector]) => /::before/.test(selector))).toEqual([]);
    expect(declarationsOf('.spr-info-mark::after')).toMatch(/content:\s*''/);
  });
});

const VIEWS = join(__dirname, '../../src/dashboard/ui/views');
const COMPONENTS = join(__dirname, '../../src/global-ui/components');
const viewTemplates = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => [
      join(dir, entry.name, `${entry.name}.eta`),
      ...viewTemplates(join(dir, entry.name)),
    ])
    .filter((file) => existsSync(file));
// Every template under the components folder, as the loader registers them
const DASHBOARD_TEMPLATES = [
  ...viewTemplates(VIEWS),
  ...readdirSync(COMPONENTS, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.eta'))
    .map((file) => join(COMPONENTS, file)),
];

describe('the file picker', () => {
  const CONTROL = declarationsOf('.spr-file');

  it('never hides the input where the filename is all there is', () => {
    for (const [selector, body] of rulesNaming('spr-file')) {
      if (selector.includes('spr-file-tucked')) continue;
      expect([selector, body].join(' — ')).not.toMatch(
        /display:\s*none|visibility:\s*hidden|opacity:\s*0\s*[;}]|position:\s*absolute/,
      );
    }
  });

  it('keeps the tucked one focusable, and gives the label its ring', () => {
    const tucked = declarationsOf('.spr-file-tucked');
    expect(tucked).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    expect(tucked).toMatch(/clip-path:/);
    expect(
      declarationsOf('.spr-stored:has(.spr-file-tucked:focus-visible) .spr-stored-pick'),
    ).toMatch(/outline:/);
  });

  it('draws the Browse label like every other button', () => {
    const label = declarationsOf('.spr-stored-pick');
    const button = declarationsOf('.spr-file::file-selector-button');
    for (const property of ['border', 'border-radius', 'border-radius', 'font-size', 'cursor']) {
      const from = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`);
      expect(from.exec(label)?.[1]).toBe(from.exec(button)?.[1]);
    }
  });

  it('mutes the Browse label when the input it names is disabled', () => {
    expect(declarationsOf('.spr-stored:has(.spr-file-tucked:disabled) .spr-stored-pick')).toMatch(
      /cursor:\s*not-allowed/,
    );
  });

  it('styles the button through the part the platform exposes', () => {
    const button = declarationsOf('.spr-file::file-selector-button');
    expect(button).toMatch(/border:/);
    expect(button).toMatch(/border-radius:/);
    expect(button).toMatch(/font:\s*inherit/);
  });

  it('draws that button like the other buttons', () => {
    const button = declarationsOf('.spr-file::file-selector-button');
    const other =
      rulesNaming('.spr-add button').find(([selector]) => !selector.includes(':hover'))?.[1] ?? '';
    expect(other).not.toBe('');
    for (const property of ['border', 'border-radius', 'color', 'cursor']) {
      const from = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`);
      expect(from.exec(button)?.[1]).toBe(from.exec(other)?.[1]);
    }
  });

  it('puts the focus ring on the input, not the button', () => {
    expect(declarationsOf('.spr-file:focus-visible')).toMatch(/outline:/);
    expect(DASHBOARD_RULES).not.toMatch(/::file-selector-button:focus/);
  });

  it('keeps saying what it holds when it is disabled', () => {
    expect(CONTROL).toMatch(/background:\s*var\(--spr-bg\)/);
    expect(declarationsOf('.spr-file:disabled')).toMatch(/color:\s*var\(--spr-muted\)/);
  });

  it('is on every file input the dashboard renders', () => {
    let seen = 0;
    for (const file of DASHBOARD_TEMPLATES) {
      const source = readFileSync(file, 'utf8');
      const pickers = (source.match(/type="file"/g) ?? []).length;
      seen += pickers;
      const styled = (source.match(/class="spr-file(?:\s+spr-file-tucked)?"/g) ?? []).length;
      expect([file, styled]).toEqual([file, pickers]);
    }
    expect(seen).toBeGreaterThan(1);
  });
});

describe('the stored-value row', () => {
  it('draws the cross from the checkbox itself, not from an element beside it', () => {
    const drop = declarationsOf('.spr-stored-drop');
    expect(drop).toMatch(/appearance:\s*none/);
    expect(declarationsOf('.spr-stored-drop::before')).toMatch(/content:/);
  });

  it('keeps the row on screen while the removal is armed', () => {
    expect(declarationsOf('.spr-stored:has(.spr-stored-drop:checked) .spr-stored-what')).toMatch(
      /line-through/,
    );
    expect(declarationsOf('.spr-stored:has(.spr-stored-drop:checked) .spr-stored-thumb')).toMatch(
      /opacity:/,
    );
    for (const [selector, body] of rulesNaming('spr-stored')) {
      expect([selector, body].join(' — ')).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    }
  });

  it('resolves what it takes away through the status vocabulary', () => {
    expect(declarationsOf('.spr-stored-drop:hover')).toMatch(/var\(--spr-status-fail\)/);
    expect(declarationsOf('.spr-stored-drop:checked')).toMatch(/var\(--spr-status-fail\)/);
  });

  it('keeps a logo of any shape inside its own box', () => {
    const thumb = declarationsOf('img.spr-stored-thumb');
    expect(thumb).toMatch(/object-fit:\s*contain/);
    expect(thumb).toMatch(/block-size:\s*[0-9.]+em/);
    expect(thumb).toMatch(/max-inline-size:/);
  });

  it('out-weighs the rule that sizes every other image in the column', () => {
    expect(declarationsOfBase('.spr-main img')).toMatch(/height:\s*auto/);
    expect(weightOf('img.spr-stored-thumb')).toEqual(weightOf('.spr-main img'));
    expect(DASHBOARD_RULES).not.toMatch(/\.spr-stored\s+\.spr-stored-thumb\s*\{/);
  });

  it('gives the cross a focus ring of its own', () => {
    expect(declarationsOf('.spr-stored-drop:focus-visible')).toMatch(/outline:/);
  });

  it('dims rather than hides the row when the form is read-only', () => {
    expect(declarationsOf('.spr-stored-drop:disabled')).toMatch(/opacity:/);
    expect(declarationsOf('.spr-stored-drop:disabled')).toMatch(/cursor:\s*not-allowed/);
  });
});

describe('the dropdown', () => {
  it('wraps every select the dashboard renders', () => {
    let seen = 0;
    for (const file of DASHBOARD_TEMPLATES) {
      const source = readFileSync(file, 'utf8');
      const selects = (source.match(/<select\b/g) ?? []).length;
      seen += selects;
      expect([file, selects, (source.match(/class="spr-select"/g) ?? []).length]).toEqual([
        file,
        selects,
        selects,
      ]);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('never takes the platform arrow off an unwrapped select', () => {
    for (const [, selector, body] of DASHBOARD_RULES.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/appearance:\s*none/.test(body)) continue;
      expect(selector.replace(/\s+/g, ' ').trim()).toMatch(/^\.spr-/);
    }
    expect(declarationsOf('.spr-select > select')).toMatch(/appearance:\s*none/);
  });

  it('draws the mark on the wrapper, because a select cannot carry one', () => {
    const mark = rulesNaming('.spr-select::after')
      .map(([, body]) => body)
      .join('\n');
    expect(mark).toMatch(/content:\s*''/);
    expect(mark).toMatch(/border-width:/);
    expect(mark).toMatch(/rotate:/);
    expect(mark).not.toMatch(/url\(/);
  });

  it('lets the mark be clicked through', () => {
    const mark = rulesNaming('.spr-select::after')
      .map(([, body]) => body)
      .join('\n');
    expect(mark).toMatch(/pointer-events:\s*none/);
  });

  it('carries its own box, so it works outside a field', () => {
    const control = declarationsOf('.spr-select > select');
    for (const property of ['border:', 'border-radius:', 'background:', 'padding:', 'font:']) {
      expect(control).toContain(property);
    }
    expect(declarationsOf('.spr-select > select:disabled')).toMatch(
      /background:\s*var\(--spr-surface\)/,
    );
  });

  it('keeps every styled-list rule behind the support query that grants it', () => {
    const block = /@supports \(appearance: base-select\)\s*\{[\s\S]*?\n {2}\}/.exec(
      DASHBOARD_RULES,
    )?.[0];
    expect(block).toBeDefined();
    const outside = DASHBOARD_RULES.replace(block!, '');
    for (const part of ['::picker(', '::picker-icon', '::checkmark', 'base-select']) {
      expect(outside).not.toContain(part);
    }
  });

  it('hides the platform arrow rather than dropping its own', () => {
    const supported = /@supports \(appearance: base-select\)\s*\{([\s\S]*?)\n {2}\}/.exec(
      DASHBOARD_RULES,
    )![1];
    expect(/::picker-icon\s*\{[^}]*display:\s*none/.test(supported)).toBe(true);
    expect(supported).not.toContain('.spr-select::after');
  });

  it('lays an option out as a row, so a mark can lead its label', () => {
    const supported = /@supports \(appearance: base-select\)\s*\{([\s\S]*?)\n {2}\}/.exec(
      DASHBOARD_RULES,
    )![1];
    const option = /\.spr-select option\s*\{([^}]*)\}/.exec(supported)?.[1] ?? '';
    expect(option).toMatch(/display:\s*flex/);
    expect(option).toMatch(/gap:\s*var\(--spr-space-/);
    const checkmark = /::checkmark\s*\{([^}]*)\}/.exec(supported)?.[1] ?? '';
    expect(checkmark).toMatch(/order:\s*1/);
    const mark = /\.spr-select option \.spr-icon\s*\{([^}]*)\}/.exec(supported)?.[1] ?? '';
    expect(mark).toMatch(/width:\s*[\d.]+em/);
  });
});

const THEME_DIR = join(__dirname, '../../src/global-ui/theme');
const TEMPLATES = readdirSync(THEME_DIR)
  .filter((f) => f.endsWith('.css') && f !== 'default.css')
  .map((f) => f.replace(/\.css$/, ''));

const RULE_CARRYING = new Set(['blueprint', 'glass']);

describe('templates', () => {
  it('ships more than one, because one cannot prove the token set', () => {
    expect(TEMPLATES.length).toBeGreaterThan(0);
  });

  for (const name of TEMPLATES) {
    const css = readFileSync(join(THEME_DIR, `${name}.css`), 'utf8');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@layer[^{;]*/g, '@layer');
    const selectorsOf = () =>
      (
        rules
          .replace(/@layer[^{]*\{/g, '')
          .replace(/@media[^{]*\{/g, '')
          .match(/(^|\})\s*([^{}@]+)\{/g) ?? []
      ).map((s) => s.replace(/[{}]/g, '').trim());

    describe(name, () => {
      it('lives in the theme layer, so it wins without specificity tricks', () => {
        expect(css).toMatch(/@layer\s+speicher\.theme\s*\{/);
      });

      if (RULE_CARRYING.has(name)) {
        it('writes rules only against the public contract', () => {
          const selectors = selectorsOf();
          expect(selectors.length).toBeGreaterThan(2);
          for (const selector of selectors) {
            if (selector === ':root') continue;
            expect(selector).toMatch(/\.spr-[a-z0-9-]+/);
          }
        });

        it('hard-codes no colour outside the token blocks', () => {
          const outside = rules.replace(/:root\s*\{[^}]*\}/g, '');
          expect(outside).not.toMatch(/#[0-9a-f]{3,8}\b/i);
          expect(outside).not.toMatch(/\b(?:rgb|hsl)a?\(/i);
        });
      } else {
        it('sets tokens and nothing else', () => {
          for (const selector of selectorsOf()) {
            expect(selector).toBe(':root');
          }
        });
      }

      it('only sets tokens the base sheet defines', () => {
        const base = new Set([...SOURCE.matchAll(/(--spr-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
        const set = [...css.matchAll(/(--spr-[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
        expect(set.filter((t) => !base.has(t))).toEqual([]);
      });

      it('answers every radius step once it answers one', () => {
        const steps = [...SOURCE.matchAll(/(--spr-radius[a-z0-9-]*)\s*:/g)].map((m) => m[1]);
        expect(steps.length).toBeGreaterThan(3);
        const answered = new Set(
          [...css.matchAll(/(--spr-radius[a-z0-9-]*)\s*:/g)].map((m) => m[1]),
        );
        if (answered.size > 0) {
          expect(steps.filter((token) => !answered.has(token))).toEqual([]);
        }
      });

      it('covers dark mode for every colour it changes', () => {
        const light = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
        const dark =
          /prefers-color-scheme:\s*dark[^{]*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
        const colourish = (block: string) =>
          [...block.matchAll(/(--spr-[a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8})/gi)].map((m) => m[1]);

        const lightColours = colourish(light);
        expect(lightColours.length).toBeGreaterThan(3);
        expect(lightColours.filter((t) => !colourish(dark).includes(t))).toEqual([]);
      });

      it('says which scheme its dark palette is, not only what its colours are', () => {
        const dark = /prefers-color-scheme:\s*dark[^{]*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1];
        expect(dark).toMatch(/--spr-color-scheme:\s*dark/);
      });

      it('actually differs from the default, or it is not a second template', () => {
        const baseTokens = new Map(
          [...SOURCE.matchAll(/(--spr-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [
            m[1],
            m[2].trim(),
          ]),
        );
        const changed = [...css.matchAll(/(--spr-[a-z0-9-]+)\s*:\s*([^;]+);/g)].filter(
          ([, token, value]) => baseTokens.get(token) !== value.trim(),
        );
        expect(changed.length).toBeGreaterThan(15);
        const names = changed.map(([, t]) => t);
        expect(names.some((t) => t.includes('font'))).toBe(true);
        expect(names.some((t) => t.includes('space'))).toBe(true);
        expect(names.some((t) => t.includes('measure') || t.includes('width'))).toBe(true);
      });
    });
  }
});

describe('the width the reader dragged the tree to', () => {
  it('is emitted as a number, and only as a number', () => {
    expect(navWidthTokens('280')).toBe(':root{--spr-nav-user:280px}');
    expect(navWidthTokens('280px')).toBeNull();
    expect(navWidthTokens('280px;background:url(https://evil.test)')).toBeNull();
    expect(navWidthTokens('url(https://evil.test)')).toBeNull();
    expect(navWidthTokens('}html{display:none')).toBeNull();
  });

  it('refuses a value that is not a width at all', () => {
    expect(navWidthTokens(undefined)).toBeNull();
    expect(navWidthTokens('')).toBeNull();
    expect(navWidthTokens('-40')).toBeNull();
    expect(navWidthTokens('Infinity')).toBeNull();
    expect(navWidthTokens(['280'])).toBeNull();
  });

  it('leaves the range to the stylesheet', () => {
    expect(navWidthTokens('99999')).toBe(':root{--spr-nav-user:4096px}');
    expect(navWidthTokens('1')).toBe(':root{--spr-nav-user:1px}');
  });
});
