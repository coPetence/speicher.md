import { PREVIEW_ATTRIBUTE, annotateLinkPreviews } from '../../src/content-reader/previews';

const PREVIEWS = [
  { href: '/handbook/setup', title: 'Setting up', description: 'Getting a working environment.' },
  { href: '/handbook/introduction', title: 'Introduction', description: null },
];

describe('annotateLinkPreviews', () => {
  it('annotates a link whose destination is in the map', () => {
    const html = annotateLinkPreviews('<p><a href="/handbook/setup">here</a></p>', PREVIEWS);
    expect(html).toContain(`${PREVIEW_ATTRIBUTE}="Setting up — Getting a working environment."`);
    expect(html).toContain('href="/handbook/setup"');
    expect(html).toContain('>here</a>');
  });

  it('uses the title alone when the destination has no description', () => {
    const html = annotateLinkPreviews('<a href="/handbook/introduction">x</a>', PREVIEWS);
    expect(html).toContain(`${PREVIEW_ATTRIBUTE}="Introduction"`);
  });

  describe('saying nothing the link already said', () => {
    it('drops a title the link text already contains', () => {
      const html = annotateLinkPreviews('<a href="/handbook/setup">Setting up</a>', PREVIEWS);
      expect(html).toContain(`${PREVIEW_ATTRIBUTE}="Getting a working environment."`);
    });

    it('drops the whole preview when nothing survives', () => {
      const source = '<a href="/handbook/introduction">Introduction</a>';
      expect(annotateLinkPreviews(source, PREVIEWS)).toBe(source);
    });

    it('ignores case, punctuation and inline markup when deciding', () => {
      const html = annotateLinkPreviews(
        '<a href="/handbook/setup">the <strong>Setting Up</strong>, page</a>',
        PREVIEWS,
      );
      expect(html).toContain(`${PREVIEW_ATTRIBUTE}="Getting a working environment."`);
    });

    it('keeps the title when the link text is a picture', () => {
      const html = annotateLinkPreviews(
        '<a href="/handbook/introduction"><img src="/x.png" alt="" /></a>',
        PREVIEWS,
      );
      expect(html).toContain(`${PREVIEW_ATTRIBUTE}="Introduction"`);
    });

    it('makes the restricted case quieter rather than louder', () => {
      const redundant = annotateLinkPreviews(
        '<a href="/handbook/introduction">Introduction</a>',
        PREVIEWS,
      );
      const restricted = annotateLinkPreviews(
        '<a href="/handbook/commercial/pricing">Introduction</a>',
        PREVIEWS,
      );
      expect(redundant).not.toContain('data-spr');
      expect(restricted).not.toContain('data-spr');
    });
  });

  it('leaves a link with no entry exactly as it was', () => {
    const source = '<a href="/handbook/commercial/pricing">Pricing</a>';
    expect(annotateLinkPreviews(source, PREVIEWS)).toBe(source);
    expect(annotateLinkPreviews(source, PREVIEWS)).not.toContain('data-spr');
  });

  it('previews the page a fragment link lands on', () => {
    const html = annotateLinkPreviews('<a href="/handbook/setup#install">x</a>', PREVIEWS);
    expect(html).toContain(PREVIEW_ATTRIBUTE);
    expect(html).toContain('href="/handbook/setup#install"');
  });

  it('escapes the attribute, so a title cannot leave it', () => {
    const html = annotateLinkPreviews('<a href="/x">x</a>', [
      { href: '/x', title: '" onmouseover="alert(1)', description: '<script>alert(2)</script>' },
    ]);
    expect(html).not.toContain('onmouseover="alert');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;');
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not annotate an external link that happens to end in the same path', () => {
    const html = annotateLinkPreviews(
      '<a href="https://elsewhere.test/handbook/setup" rel="noopener">x</a>',
      PREVIEWS,
    );
    expect(html).not.toContain(PREVIEW_ATTRIBUTE);
  });

  it('preserves the other attributes the sanitiser emitted', () => {
    const html = annotateLinkPreviews(
      '<a id="anchor" href="/handbook/setup" data-broken="true">x</a>',
      PREVIEWS,
    );
    expect(html).toContain('id="anchor"');
    expect(html).toContain('data-broken="true"');
    expect(html).toContain(PREVIEW_ATTRIBUTE);
  });

  it('keeps the element it matched intact around the annotated anchor', () => {
    const html = annotateLinkPreviews(
      '<p>See <a href="/handbook/setup">the <code>setup</code> notes</a> first.</p>',
      PREVIEWS,
    );
    expect(html).toContain('<code>setup</code>');
    expect(html).toContain('</a> first.</p>');
    expect(html.match(/<\/a>/g)).toHaveLength(1);
  });

  it('annotates each of several links independently', () => {
    const html = annotateLinkPreviews(
      '<a href="/handbook/setup">a</a> and <a href="/handbook/introduction">b</a>',
      PREVIEWS,
    );
    expect(html.match(/data-spr-preview=/g)).toHaveLength(2);
  });

  it('truncates a long description on a word boundary', () => {
    const html = annotateLinkPreviews('<a href="/x">x</a>', [
      { href: '/x', title: 'T', description: 'word '.repeat(80) },
    ]);
    const value = /data-spr-preview="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(value.length).toBeLessThanOrEqual(181);
    expect(value.endsWith('…')).toBe(true);
    expect(value).not.toMatch(/wor…$/);
  });

  it('is a no-op with an empty map, and does not touch unrelated markup', () => {
    const source = '<p>Text with <code>a[href]</code> in it.</p><a href="/x">x</a>';
    expect(annotateLinkPreviews(source, [])).toBe(source);
  });
});
