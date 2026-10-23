import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  COVER_PATTERNS,
  coverPatternFor,
  renderCoverPattern,
} from '../../src/content-reader/cover-patterns';

describe('choosing a default cover', () => {
  it('gives a repository the same tile every time', () => {
    for (const key of ['copetence/handbook', 'northwind-engineering/specs', 'a', '']) {
      expect(coverPatternFor(key).name).toBe(coverPatternFor(key).name);
    }
  });

  it('is a property of the name and nothing else', () => {
    expect(coverPatternFor('copetence/handbook').name).toBe('crosses');
    expect(coverPatternFor('northwind-engineering/specs').name).toBe('scales');
    expect(coverPatternFor('copetence/fieldkit').name).toBe('dots');
  });

  it('reaches every tile, so none is decoration nobody sees', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(coverPatternFor(`acme/repo-${i}`).name);
    expect([...seen].sort()).toEqual(COVER_PATTERNS.map((p) => p.name).sort());
  });

  it('spreads them, rather than answering with one tile for most names', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 800; i++) {
      const name = coverPatternFor(`acme/repo-${i}`).name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const count of counts.values()) expect(count).toBeGreaterThan(30);
  });

  it('names each tile once', () => {
    const names = COVER_PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the rendered tile', () => {
  const markup = COVER_PATTERNS.map((p) => renderCoverPattern(p.name, 'spr-cover-0')).join('');

  it('paints in currentColor and hard-codes no value', () => {
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
    expect(markup).toContain('stroke="currentColor"');
  });

  it('tiles rather than scales', () => {
    for (const key of COVER_PATTERNS.map((p) => p.name)) {
      const tile = coverPatternFor(key);
      const svg = renderCoverPattern(key, 'spr-cover-0');
      expect(svg).toContain('patternUnits="userSpaceOnUse"');
      expect(svg).toContain(`width="${tile.width}" height="${tile.height}"`);
      expect(svg).not.toContain('viewBox');
    }
  });

  it('is hidden from a screen reader, which the title already told', () => {
    expect(markup.match(/aria-hidden="true"/g)?.length).toBe(COVER_PATTERNS.length);
  });

  it('escapes the id, the one value it does not own', () => {
    const svg = renderCoverPattern('anything', 'a"><script>');
    expect(svg).not.toContain('<script');
    expect(svg).toContain('&quot;>&lt;script>');
  });

  it('carries the geometry unchanged from the tile it names', () => {
    const pattern = coverPatternFor('copetence/handbook');
    expect(renderCoverPattern('copetence/handbook', 'x')).toContain(`d="${pattern.d}"`);
  });
});

describe('the stylesheet the tiles depend on', () => {
  const css = readFileSync(join(__dirname, '../../src/global-ui/theme/default.css'), 'utf8');

  it('gives the cover a box fixed in both directions, and crops to it', () => {
    // A width and a ratio rather than two lengths: the landing page draws this box
    // at the article's width, and a card whose crop differed from it would make the
    // card a false claim about the page. `theme.spec.ts` owns that sharing.
    const box = /\.spr-cover\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(box).toContain('--spr-cover-width');
    expect(box).toContain('--spr-cover-ratio');
    expect(box).toContain('overflow: hidden');
    const image = /\.spr-repos \.spr-cover img[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(image).toContain('object-fit: cover');
    expect(image).toContain('height: 100%');
  });

  it('sizes the grid track off the same token as the card', () => {
    const grid = /\.spr-repos\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(grid).toContain('repeat(auto-fill, minmax(var(--spr-cover-width), 1fr))');
  });

  it('colours the tile through tokens', () => {
    const art = /\.spr-cover-art\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(art).toContain('var(--spr-cover-mark)');
    expect(art).toContain('var(--spr-cover-mark-opacity)');
  });
});
