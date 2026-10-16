import { CALLOUT_LEVELS } from '../../src/ingest/callouts';
import { CODE_TOKENS, CODE_TOKEN_PREFIX, isHighlightable } from '../../src/ingest/highlight';
import {
  headingSlug,
  renderMarkdown,
  rewriteMarkdownLinks,
  stripLeadingH1,
} from '../../src/ingest/markdown';

describe('sanitisation', () => {
  it('drops script tags and their contents', () => {
    const { html } = renderMarkdown('# Hi\n\n<script>fetch("/steal")</script>\n');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('fetch("/steal")');
  });

  it('drops event handler attributes', () => {
    const { html } = renderMarkdown('<p onclick="steal()">click</p>\n');
    expect(html).not.toContain('onclick');
  });

  it('drops iframes, objects, embeds and forms', () => {
    const { html } = renderMarkdown(
      '<iframe src="https://evil.test"></iframe>\n<object></object>\n<embed>\n<form action="/x"><input name="p"></form>\n',
    );
    for (const tag of ['<iframe', '<object', '<embed', '<form', '<input']) {
      expect(html).not.toContain(tag);
    }
  });

  it('drops style tags and style attributes', () => {
    const { html } = renderMarkdown(
      '<style>body{display:none}</style>\n<p style="position:fixed">x</p>\n',
    );
    expect(html).not.toContain('<style');
    expect(html).not.toContain('style=');
  });

  const attributeUrls = (html: string): string[] =>
    [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]);

  it('never emits a javascript: URL as a link target', () => {
    const { html } = renderMarkdown(
      '[click](javascript:alert(1))\n\n<a href="javascript:alert(2)">raw</a>\n',
    );
    expect(attributeUrls(html).some((u) => u.toLowerCase().startsWith('javascript:'))).toBe(false);
    expect(html).toContain('click');
  });

  it('never emits a data: URL as a link or image target', () => {
    const { html } = renderMarkdown(
      [
        '[a](data:text/html,hello)',
        '',
        '![b](data:image/png;base64,iVBORw0KGgo=)',
        '',
        '<img src="data:image/svg+xml,%3Csvg%20onload%3Dx%3E">',
      ].join('\n'),
    );
    expect(attributeUrls(html).some((u) => u.toLowerCase().startsWith('data:'))).toBe(false);
  });

  it('never emits a protocol-relative URL, which inherits the page scheme', () => {
    const { html } = renderMarkdown('<a href="//evil.test/x">go</a>\n');
    expect(attributeUrls(html).some((u) => u.startsWith('//'))).toBe(false);
  });

  it('blocks a remote image rather than rendering it', () => {
    const { html, blockedImages } = renderMarkdown('![x](https://tracker.test/pixel.png)\n');
    expect(html).not.toContain('tracker.test');
    expect(blockedImages).toEqual(['https://tracker.test/pixel.png']);
  });

  it('proxies a remote image when a proxy is supplied', () => {
    const { html } = renderMarkdown('![x](https://cdn.test/a.png)\n', {
      resolveExternalImage: (url) => `/proxy?u=${encodeURIComponent(url)}`,
    });
    expect(html).toContain('/proxy?u=');
  });

  it('marks external links noopener noreferrer', () => {
    const { html } = renderMarkdown('[out](https://example.test/x)\n');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('opens an external web link in a new tab', () => {
    for (const href of ['https://example.test/x', 'http://example.test/x', '//example.test/x']) {
      const { html } = renderMarkdown(`[out](${href})\n`);
      expect(html).toMatch(/<a [^>]*target="_blank"[^>]*>out</);
    }
  });

  it('opens a link written as raw HTML in a new tab too, even when it names another target', () => {
    const { html } = renderMarkdown('<a href="https://example.test/x" target="_self">out</a>\n');
    expect(html.match(/target="[^"]*"/g)).toEqual(['target="_blank"']);
  });

  it('leaves a mail link, an in-page link and an internal link in the same tab', () => {
    const { html } = renderMarkdown(
      '[mail](mailto:ferdinand.duschka@copetence.de) [jump](#top) [page](./guide.md)\n',
      { resolveLink: () => '/repo/guide' },
    );
    expect(html).not.toContain('target=');
    expect(html).not.toContain('spr-link-external');
  });

  it('marks an external link with an icon and a note for screen readers', () => {
    const { html } = renderMarkdown('[out](https://example.test/x)\n');
    const link = /<a [^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1] ?? '';
    expect(link).toMatch(/^out<svg class="spr-icon spr-link-external"[^>]*aria-hidden="true">/);
    expect(link).toMatch(/<span class="spr-visually-hidden"> \(opens in a new tab\)<\/span>$/);
  });

  it('keeps the mark out of the plain text that search reads', () => {
    const { plain } = renderMarkdown('See [out](https://example.test/x).\n');
    expect(plain).toBe('See out.');
  });

  it('keeps ordinary formatting intact', () => {
    const { html } = renderMarkdown(
      '# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
    );
    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<table>');
  });
});

describe('link resolution', () => {
  it('rewrites a relative link through the resolver', () => {
    const { html } = renderMarkdown('[a](other.md)\n', {
      resolveLink: (target) => `/base/${target.replace(/\.md$/, '')}`,
    });
    expect(html).toContain('href="/base/other"');
  });

  it('reports a target the resolver rejects, without failing', () => {
    const { html, brokenLinks } = renderMarkdown('[a](gone.md)\n', { resolveLink: () => null });
    expect(brokenLinks).toEqual(['gone.md']);
    expect(html).toContain('data-broken="true"');
  });

  it('leaves fragment-only links alone', () => {
    const { html } = renderMarkdown('[a](#section)\n', { resolveLink: () => '/wrong' });
    expect(html).toContain('href="#section"');
  });
});

describe('plain text extraction', () => {
  it('produces searchable text without markup', () => {
    const { plain } = renderMarkdown('# Title\n\nSome **bold** text.\n');
    expect(plain).toContain('Title');
    expect(plain).toContain('Some bold text.');
    expect(plain).not.toContain('<');
  });
});

describe('heading extraction', () => {
  it('finds an ATX H1', () => {
    expect(renderMarkdown('# Hello world\n').firstHeading).toBe('Hello world');
  });

  it('finds a setext H1', () => {
    expect(renderMarkdown('Hello world\n===========\n').firstHeading).toBe('Hello world');
  });

  it('strips inline markup from the heading', () => {
    expect(renderMarkdown('# The `speicher` **tool**\n').firstHeading).toBe('The speicher tool');
  });

  it('returns null when there is no H1', () => {
    expect(renderMarkdown('## Only an H2\n').firstHeading).toBeNull();
  });
});

describe('markdown link rewriting for MCP', () => {
  const resolve = (target: string) => `/~repo~/${target.replace(/\.md$/, '')}`;

  it('rewrites inline links and images', () => {
    const out = rewriteMarkdownLinks('See [intro](intro.md) and ![chart](img/c.png).', resolve);
    expect(out).toBe('See [intro](/~repo~/intro) and ![chart](/~repo~/img/c.png).');
  });

  it('preserves a link title', () => {
    const out = rewriteMarkdownLinks('[a](b.md "Title")', resolve);
    expect(out).toBe('[a](/~repo~/b "Title")');
  });

  it('rewrites reference definitions', () => {
    const out = rewriteMarkdownLinks('[ref]: target.md', resolve);
    expect(out).toBe('[ref]: /~repo~/target');
  });

  it('leaves absolute and fragment targets alone', () => {
    const input = '[a](https://example.test) and [b](#anchor)';
    expect(rewriteMarkdownLinks(input, resolve)).toBe(input);
  });

  it('leaves fenced code blocks untouched', () => {
    const input = ['Before [x](x.md)', '```md', '[a](b.md)', '```', 'After [y](y.md)'].join('\n');
    const out = rewriteMarkdownLinks(input, resolve);
    expect(out).toContain('[a](b.md)');
    expect(out).toContain('[x](/~repo~/x)');
    expect(out).toContain('[y](/~repo~/y)');
  });

  it('leaves a target the resolver rejects as it was', () => {
    expect(rewriteMarkdownLinks('[a](gone.md)', () => null)).toBe('[a](gone.md)');
  });
});

describe('rich content survives the allowlist', () => {
  const render = (src: string) => renderMarkdown(src).html;

  it('keeps tables, including the header and body structure', () => {
    const html = render('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('drops a header row whose every cell is empty, since that is not a header', () => {
    const html = render('|  |  |\n| --- | --- |\n| 1 | 2 |\n');
    expect(html).toContain('<table>');
    expect(html).not.toContain('<thead>');
    expect(html).not.toContain('<th>');
    expect(html).toContain('<td>1</td>');
  });

  it('keeps a header row where only some cells are empty', () => {
    const html = render('|  | b |\n| --- | --- |\n| 1 | 2 |\n');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th>b</th>');
  });

  it('keeps body alignment when the empty header row goes', () => {
    const html = render('|  |  |\n| :-- | --: |\n| 1 | 2 |\n');
    expect(html).not.toContain('<thead>');
    expect(html).toContain('<td align="left">1</td>');
    expect(html).toContain('<td align="right">2</td>');
  });

  it('translates column alignment into `align`, since `style` is banned', () => {
    const html = render('| a | b |\n| :-- | --: |\n| 1 | 2 |\n');
    expect(html).toContain('align="left"');
    expect(html).toContain('align="right"');
    expect(html).not.toContain('style=');
  });

  it('ignores an alignment value that is not one of the four keywords', () => {
    const html = render(
      '<table><tr><td style="text-align:expression(alert(1))">x</td></tr></table>',
    );
    expect(html).not.toContain('align=');
    expect(html).not.toContain('style=');
  });

  it('keeps strikethrough, which markdown-it renders as <s> rather than <del>', () => {
    expect(render('~~gone~~')).toContain('<s>gone</s>');
  });

  it('keeps nested lists at every depth', () => {
    const html = render('- a\n  - b\n    - c\n');
    expect(html.match(/<ul>/g)).toHaveLength(3);
  });

  it('keeps ordered lists', () => {
    expect(render('1. one\n2. two\n')).toContain('<ol>');
  });

  it('keeps the language class on a fenced block', () => {
    expect(render('```yaml\naccess: [a]\n```\n')).toContain('class="language-yaml"');
  });

  it('keeps indented code blocks', () => {
    expect(render('    SELECT 1;\n')).toContain('<pre><code>SELECT 1;');
  });

  it('keeps nested blockquotes', () => {
    const html = render('> outer\n>\n> > inner\n');
    expect(html.match(/<blockquote>/g)).toHaveLength(2);
  });

  it('keeps details, summary, dl and kbd', () => {
    const html = render(
      '<details><summary>s</summary>body</details>\n\n<dl><dt>t</dt><dd>d</dd></dl>\n\n<kbd>C</kbd>\n',
    );
    for (const tag of ['<details>', '<summary>', '<dl>', '<dt>', '<dd>', '<kbd>']) {
      expect(html).toContain(tag);
    }
  });

  it('keeps horizontal rules however they were written', () => {
    expect(render('---\n\n***\n\n___\n').match(/<hr\s*\/?>/g)).toHaveLength(3);
  });

  it('keeps a mailto link', () => {
    expect(render('[m](mailto:a@b.test)')).toContain('href="mailto:a@b.test"');
  });
});

describe('callouts', () => {
  const render = (src: string) => renderMarkdown(src).html;

  it('boxes a directive, labelled with its kind', () => {
    const html = render(':::note\nBody text.\n:::\n');
    expect(html).toContain('class="spr-callout spr-callout-note"');
    expect(html).toContain('<p class="spr-callout-label">Note</p>');
    expect(html).toContain('<p>Body text.</p>');
    expect(html).not.toContain(':::');
  });

  it('boxes a GitHub alert the same way, and drops the marker line', () => {
    const html = render('> [!WARNING]\n> Mind the gap.\n');
    expect(html).toContain('class="spr-callout spr-callout-warning"');
    expect(html).toContain('<p class="spr-callout-label">Warning</p>');
    expect(html).toContain('<p>Mind the gap.</p>');
    expect(html).not.toContain('[!WARNING]');
    expect(html).not.toContain('<blockquote>');
  });

  it("reads `caution` as each syntax's own authors meant it", () => {
    expect(render(':::caution\nx\n:::\n')).toContain('spr-callout-warning');
    expect(render('> [!CAUTION]\n> x\n')).toContain('spr-callout-danger');
    expect(render(':::caution\nx\n:::\n')).toContain('>Caution</p>');
    expect(render('> [!CAUTION]\n> x\n')).toContain('>Caution</p>');
  });

  it('covers every kind both syntaxes can name', () => {
    for (const kind of ['note', 'info', 'tip', 'important', 'warning', 'danger', 'caution']) {
      expect(render(`:::${kind}\nx\n:::\n`)).toContain('spr-callout-');
    }
    for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
      expect(render(`> [!${kind}]\n> x\n`)).toContain('spr-callout-');
    }
  });

  it('only ever emits a level the stylesheet knows', () => {
    const levels = new Set(
      ['note', 'info', 'tip', 'important', 'warning', 'danger', 'caution']
        .flatMap((k) => [render(`:::${k}\nx\n:::\n`)])
        .concat(
          ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'].map((k) => render(`> [!${k}]\n> x\n`)),
        )
        .flatMap((html) =>
          [...html.matchAll(/class="spr-callout spr-callout-([a-z]+)"/g)].map((m) => m[1]),
        ),
    );
    expect([...levels].filter((l) => !CALLOUT_LEVELS.includes(l as never))).toEqual([]);
  });

  it('takes a title in either spelling the ecosystems use', () => {
    expect(render(':::caution[Deprecated]\nx\n:::\n')).toContain('>Deprecated</p>');
    expect(render(':::tip Old style\nx\n:::\n')).toContain('>Old style</p>');
  });

  it('renders inline markup in a title', () => {
    const html = render(':::note[The `access` key]\nx\n:::\n');
    expect(html).toContain('<code>access</code>');
  });

  it('leaves a directive it does not recognise as text', () => {
    const html = render(':::mermaid\ngraph TD;\n:::\n');
    expect(html).not.toContain('spr-callout');
    expect(html).toContain('graph TD;');
  });

  it('leaves an ordinary blockquote alone', () => {
    const html = render('> Just a quotation.\n');
    expect(html).toContain('<blockquote>');
    expect(html).not.toContain('spr-callout');
  });

  it('leaves both syntaxes alone inside a code fence', () => {
    const html = render('```md\n> [!NOTE]\n:::note\n:::\n```\n');
    expect(html).not.toContain('spr-callout');
    expect(html.replace(/<[^>]+>/g, '')).toContain(':::note');
  });

  it('keeps block content inside the box', () => {
    const html = render(':::warning\n- a\n- b\n\nAnd a paragraph.\n:::\n');
    expect(html).toContain('<ul>');
    expect(html.indexOf('</ul>')).toBeLessThan(html.indexOf('</div>'));
  });

  it('works where the corpus actually puts them, indented inside a list item', () => {
    const html = render('1. Step\n\n    :::tip[Behind the Scenes]\n    Why it works.\n    :::\n');
    expect(html).toContain('spr-callout-tip');
    expect(html).toContain('>Behind the Scenes</p>');
  });

  it('survives an alert with nothing under it', () => {
    const html = render('> [!NOTE]\n');
    expect(html).toContain('spr-callout-note');
    expect(html).not.toContain('<p></p>');
  });

  it('indexes the body as text', () => {
    const { plain } = renderMarkdown('> [!TIP]\n> Run it twice.\n');
    expect(plain).toContain('Run it twice.');
    expect(plain).not.toContain('spr-callout');
  });

  it('refuses a class outside the callout family', () => {
    const html = renderMarkdown(
      '<div class="spr-callout spr-callout-danger"><p class="spr-header">x</p></div>\n',
    ).html;
    expect(html).toContain('spr-callout-danger');
    expect(html).not.toContain('spr-header');
  });
});

describe('syntax highlighting', () => {
  const fence = (lang: string, code: string) => `\`\`\`${lang}\n${code}\n\`\`\`\n`;

  it('tokenises a fence in a language it knows', () => {
    const { html } = renderMarkdown(fence('python', 'def f(x):\n    return 1'));
    expect(html).toContain(`${CODE_TOKEN_PREFIX}keyword`);
    expect(html).toContain(`${CODE_TOKEN_PREFIX}number`);
  });

  it("emits our class names and never the highlighter's", () => {
    const { html } = renderMarkdown(
      [fence('java', 'class A { void f() {} }'), fence('yaml', 'key: value # c')].join('\n'),
    );
    expect(html).not.toContain('hljs');
    for (const cls of [...html.matchAll(/<span class="([^"]*)"/g)].map((m) => m[1])) {
      expect(cls.startsWith(CODE_TOKEN_PREFIX)).toBe(true);
      expect(CODE_TOKENS).toContain(cls.slice(CODE_TOKEN_PREFIX.length));
    }
  });

  it('leaves a fence in an unknown language exactly as it was written', () => {
    const { html } = renderMarkdown(fence('hcl', 'resource "a" "b" { x = 1 }'));
    expect(html).toContain('class="language-hcl"');
    expect(html).not.toContain('<span');
    expect(html).toContain('resource "a" "b" { x = 1 }');
  });

  it('leaves a fence with no language alone', () => {
    const { html } = renderMarkdown('```\nSELECT 1;\n```\n');
    expect(html).not.toContain('<span');
  });

  it('highlights a sample that is not valid in its own language', () => {
    const { html } = renderMarkdown(fence('java', 'class A {   // ... and the rest'));
    expect(html).toContain(`${CODE_TOKEN_PREFIX}keyword`);
    expect(html.replace(/<[^>]+>/g, '')).toContain('class A {   // ... and the rest');
  });

  it('keeps the code itself byte-for-byte', () => {
    const source = 'def f(x):\n    if x:\n        return  "a"  # two spaces\n    return None';
    const { html } = renderMarkdown(fence('python', source));
    const text = html
      .replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    expect(text.trim()).toBe(source);
  });

  it('indexes the code as text, not as markup', () => {
    const { plain } = renderMarkdown(fence('go', 'func main() { println("hi") }'));
    expect(plain).toContain('func main() { println("hi") }');
    expect(plain).not.toContain(CODE_TOKEN_PREFIX);
  });

  it('covers the languages the fixture repos actually use', () => {
    for (const lang of [
      'python',
      'java',
      'go',
      'ruby',
      'bash',
      'ts',
      'typescript',
      'shell',
      'json',
      'diff',
      'tsx',
      'yaml',
      'yml',
      'xml',
      'sql',
      'kotlin',
      'dockerfile',
      'toml',
    ]) {
      expect(isHighlightable(lang)).toBe(true);
    }
  });

  it('refuses a class the document chose for itself', () => {
    const { html } = renderMarkdown(
      '<span class="spr-tok-string">fake</span>\n\n<pre class="spr-header">chrome</pre>\n',
    );
    expect(html).not.toContain('spr-header');
    expect(html).toContain('fake');
    expect(html).toContain('spr-tok-string');
  });
});

describe('heading anchors', () => {
  it('gives every heading an id', () => {
    const { html } = renderMarkdown('# One\n\n## Two words\n\n### Three more words\n');
    expect(html).toContain('<h1 id="one">');
    expect(html).toContain('<h2 id="two-words">');
    expect(html).toContain('<h3 id="three-more-words">');
  });

  it('matches the anchor content already links to', () => {
    const { html } = renderMarkdown('[go](#control-plane)\n\n### Control plane\n');
    expect(html).toContain('href="#control-plane"');
    expect(html).toContain('id="control-plane"');
  });

  it('disambiguates repeated headings', () => {
    const { html } = renderMarkdown('## Setup\n\n## Setup\n\n## Setup\n');
    expect(html).toContain('id="setup"');
    expect(html).toContain('id="setup-1"');
    expect(html).toContain('id="setup-2"');
  });

  it('survives the sanitiser', () => {
    expect(renderMarkdown('## Kept\n').html).toContain('id="kept"');
  });

  it('respects an id the author wrote by hand', () => {
    expect(renderMarkdown('<h2 id="chosen">Mine</h2>\n').html).toContain('id="chosen"');
  });

  it('drops punctuation and transliterates, as the common convention does', () => {
    expect(headingSlug('What is `code`?')).toBe('what-is-code');
    expect(headingSlug('Prüfung und Größe')).toBe('pruefung-und-groesse');
  });

  it('does not collapse the hyphens that removed punctuation leaves behind', () => {
    expect(headingSlug('Pricing & Limits')).toBe('pricing--limits');
    expect(headingSlug('Pause & Resume Sandboxes')).toBe('pause--resume-sandboxes');
  });

  it('leaves a heading with no sluggable text alone', () => {
    expect(headingSlug('###')).toBe('');
    const { html } = renderMarkdown('## ???\n');
    expect(html).not.toContain('id=""');
  });
});

describe('lifting the title out of the body', () => {
  const render = (src: string) => stripLeadingH1(renderMarkdown(src).html);

  it('removes the opening heading', () => {
    expect(render('# Setup\n\nText.\n')).toBe('<p>Text.</p>\n');
  });

  it('removes it with its inline markup and its anchor', () => {
    const html = render('# The `speicher` **tool**\n\nText.\n');
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('speicher');
    expect(html).toBe('<p>Text.</p>\n');
  });

  it('removes the setext form too', () => {
    expect(render('Setup\n=====\n\nText.\n')).toBe('<p>Text.</p>\n');
  });

  it('leaves an H1 that is not the first element', () => {
    const html = render('Intro.\n\n# Later\n');
    expect(html).toContain('<h1 id="later">Later</h1>');
  });

  it('removes only one', () => {
    const html = render('# First\n\n# Second\n');
    expect(html).not.toContain('First');
    expect(html).toContain('<h1 id="second">Second</h1>');
  });

  it('leaves a page that opens at any other level alone', () => {
    const html = render('## Adding a repository\n\nText.\n');
    expect(html).toContain('<h2 id="adding-a-repository">');
  });

  it('does not touch what is chunked, so no embedding is re-billed', () => {
    const { plain, html } = renderMarkdown('# Setup\n\nText.\n');
    expect(plain).toContain('Setup');
    expect(stripLeadingH1(html)).not.toContain('Setup');
  });

  it('agrees with the id the read layer puts back', () => {
    const { html } = renderMarkdown('# Setup\n');
    expect(html).toContain(`id="${headingSlug('Setup')}"`);
  });
});
