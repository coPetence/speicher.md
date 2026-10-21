import {
  PROVIDER_MARKS,
  markSprite,
  parseMark,
  renderInlineMark,
} from '../../src/dashboard/ui/provider-marks';
import {
  DEFAULT_ICONS,
  iconExists,
  iconNames,
  iconOf,
  renderIconRef,
  renderSprite,
  suggestIcon,
} from '../../src/content-reader/icons';

describe('the bundled icon set', () => {
  it('knows the icons Lucide ships, by kebab-case name', () => {
    expect(iconExists('book-open')).toBe(true);
    expect(iconExists('circle-alert')).toBe(true);
    expect(iconNames().length).toBeGreaterThan(1000);
  });

  it('does not know a name that is not an icon', () => {
    expect(iconExists('definitely-not-an-icon')).toBe(false);
    expect(iconExists('')).toBe(false);
  });

  it('takes lowercase kebab-case only, matching the frontmatter schema', () => {
    expect(iconExists('BookOpen')).toBe(false);
    expect(iconExists('Book-Open')).toBe(false);
    expect(iconExists('book_open')).toBe(false);
    expect(iconNames().every((n) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(n))).toBe(true);
  });

  it('resolves names whose PascalCase export is ambiguous', () => {
    expect(iconExists('link-2')).toBe(true);
    expect(iconExists('grid-2x2')).toBe(true);
    expect(iconExists('arrow-up-0-1')).toBe(true);
    expect(iconExists('columns-2')).toBe(true);
    expect(iconExists('heading-1')).toBe(true);
  });

  it('accepts a name with or without the digit hyphen, since both are unambiguous', () => {
    expect(iconExists('link2')).toBe(true);
    expect(iconExists('link-2')).toBe(true);
  });

  it('suggests the near match for a typo', () => {
    expect(suggestIcon('book-opn')).toBe('book-open');
    expect(suggestIcon('receipt-euroo')).toBe('receipt-euro');
  });

  it('suggests nothing for a name that resembles no icon', () => {
    expect(suggestIcon('xyzzy-plugh-frobnicate')).toBeNull();
  });
});

describe('the per-page sprite', () => {
  it('emits one symbol per distinct icon', () => {
    const sprite = renderSprite(['book-open', 'wrench', 'book-open']);
    expect(sprite.match(/<symbol /g)).toHaveLength(2);
  });

  it('is empty when a page uses no icons, so it costs nothing', () => {
    expect(renderSprite([])).toBe('');
    expect(renderSprite(['', 'not-an-icon'])).toBe('');
  });

  it('silently drops a name that is not an icon', () => {
    const sprite = renderSprite(['book-open', 'not-an-icon']);
    expect(sprite).toContain('id="i-book-open"');
    expect(sprite).not.toContain('not-an-icon');
  });

  it('emits only the closed vocabulary of shape elements', () => {
    const sprite = renderSprite(iconNames().slice(0, 200));
    const tags = [...new Set([...sprite.matchAll(/<([a-z]+)[\s/>]/g)].map((m) => m[1]))];
    expect(tags.sort()).toEqual(
      ['circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect', 'svg', 'symbol'].filter(
        (t) => tags.includes(t),
      ),
    );
  });

  it('carries no script, style or event handler', () => {
    const sprite = renderSprite(iconNames().slice(0, 500));
    expect(sprite).not.toMatch(/<script/i);
    expect(sprite).not.toMatch(/\son[a-z]+=/i);
    expect(sprite).not.toMatch(/style=/i);
    expect(sprite).not.toMatch(/href=|xlink:/i);
  });

  it('is hidden, so it occupies no layout', () => {
    const sprite = renderSprite(['book-open']);
    expect(sprite).toContain('display="none"');
    expect(sprite).toContain('hidden');
  });
});

describe('the default icon', () => {
  it('names an icon Lucide ships, for each kind', () => {
    for (const name of Object.values(DEFAULT_ICONS)) expect(iconExists(name)).toBe(true);
  });

  it('gives way to a named icon and follows the kind otherwise', () => {
    expect(iconOf({ kind: 'page', icon: 'sparkles' })).toBe('sparkles');
    expect(iconOf({ kind: 'page', icon: null })).toBe(DEFAULT_ICONS.page);
    expect(iconOf({ kind: 'folder', icon: null })).toBe(DEFAULT_ICONS.folder);
    expect(iconOf({ icon: null })).toBe(DEFAULT_ICONS.page);
  });
});

describe('an icon reference', () => {
  it('points at the symbol rather than repeating its geometry', () => {
    const ref = renderIconRef('book-open');
    expect(ref).toContain('<use href="#i-book-open"/>');
    expect(ref.length).toBeLessThan(256);
  });

  it('renders nothing for an absent or unknown name', () => {
    expect(renderIconRef(null)).toBe('');
    expect(renderIconRef(undefined)).toBe('');
    expect(renderIconRef('not-an-icon')).toBe('');
  });

  it('is hidden from assistive technology, since the title beside it is the name', () => {
    expect(renderIconRef('book-open')).toContain('aria-hidden="true"');
  });

  it('inherits the surrounding text colour', () => {
    expect(renderIconRef('book-open')).toContain('stroke="currentColor"');
  });
});

describe('the provider marks', () => {
  it('is hidden the only way an SVG-namespace element can be', () => {
    const sprite = markSprite(['microsoft']);
    expect(sprite).toContain('display="none"');
    expect(sprite).toContain('hidden');
  });

  it('carries one symbol per distinct mark, and nothing for a name it lacks', () => {
    const sprite = markSprite(['github', 'github', 'openid']);
    expect([...sprite.matchAll(/<symbol /g)]).toHaveLength(2);
    expect(sprite).toContain('id="m-github"');
    expect(markSprite([''])).toBe('');
    expect(markSprite(['not-a-mark'])).toBe('');
  });

  it('follows the theme where it can, and keeps the brand’s colours where it cannot', () => {
    expect(markSprite(['github'])).toContain('currentColor');
    expect(markSprite(['openid'])).toContain('currentColor');
    expect(markSprite(['microsoft'])).toMatch(/#[0-9A-Fa-f]{6}/);
  });

  it('frames each mark on its own shapes, so one is not optically smaller', () => {
    expect(PROVIDER_MARKS.microsoft.viewBox).toBe('5 5 22 22');
    expect(PROVIDER_MARKS.openid.viewBox).toBe('100 286 800 741');
    expect(PROVIDER_MARKS.mail.viewBox).toBe('0 0 24 24');
  });

  it('carries a mark for every kind a content source can be', () => {
    for (const forge of ['github', 'git', 'gitlab', 'gitea', 'forgejo']) {
      expect(PROVIDER_MARKS[forge]).toBeDefined();
    }
  });

  it('carries its size in the markup when it is drawn inline', () => {
    const mark = renderInlineMark('microsoft', 'spr-icon');
    expect(mark).toContain('width="16"');
    expect(mark).toContain('height="16"');
    expect(mark).toContain('viewBox="5 5 22 22"');
    expect(mark).toContain('aria-hidden="true"');
    expect(mark).not.toContain('<use');
    expect(renderInlineMark('not-a-mark', 'spr-icon')).toBe('');
  });

  it('keeps the presentation a stroked mark needs when it is drawn inline', () => {
    expect(renderInlineMark('mail', 'spr-icon')).toContain('stroke="currentColor"');
  });

  it('emits no script, no handler, no outward reference', () => {
    const shapes =
      markSprite(Object.keys(PROVIDER_MARKS)).replace(/^<svg[^>]*>/, '') +
      Object.keys(PROVIDER_MARKS)
        .map((name) => renderInlineMark(name, 'spr-icon').replace(/^<svg[^>]*>/, ''))
        .join('');
    expect(shapes).not.toMatch(/<script/i);
    expect(shapes).not.toMatch(/\son[a-z]+=/i);
    expect(shapes).not.toMatch(/style=/i);
    expect(shapes).not.toMatch(/xlink:|https?:/i);
  });
});

describe('a mark file', () => {
  it('gives the page its viewBox, its presentation attributes and its shapes', () => {
    const mark = parseMark(
      [
        '<!-- notes for whoever edits the file -->',
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" fill="currentColor">',
        '  <path d="M0 0h24v24H0z"/>',
        '  <circle cx="12" cy="12" r="4"/>',
        '</svg>',
      ].join('\n'),
      'example',
    );

    expect(mark).toEqual({
      viewBox: '0 0 24 24',
      attrs: 'fill="currentColor"',
      body: '<path d="M0 0h24v24H0z"/><circle cx="12" cy="12" r="4"/>',
    });
  });

  it('keeps its gradients apart from its shapes', () => {
    const mark = parseMark(
      '<svg viewBox="0 0 1 1"><defs> <linearGradient id="m-x-g0"/> </defs><path fill="url(#m-x-g0)"/></svg>',
      'x',
    );

    expect(mark.defs).toBe('<linearGradient id="m-x-g0"/>');
    expect(mark.body).toBe('<path fill="url(#m-x-g0)"/>');
  });

  it('refuses a file with no viewBox, at startup rather than as an empty box', () => {
    expect(() => parseMark('<svg><path/></svg>', 'boxless')).toThrow(/boxless\.svg has no viewBox/);
  });
});
