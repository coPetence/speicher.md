import { renderMarkdown } from '../../src/ingest/markdown';
import { KNOWN_COMPONENTS, TABS_SYNC_ATTR } from '../../src/ingest/mdx/mdx';

function mdx(source: string) {
  return renderMarkdown(source, { mdx: true, resolveLink: (target) => `/r/${target}` });
}

function md(source: string) {
  return renderMarkdown(source, { resolveLink: (target) => `/r/${target}` });
}

describe('module code', () => {
  it('leaves top-level imports and exports out of the page', () => {
    const { html } = mdx(
      "import { Tabs } from '@astrojs/starlight/components';\nimport {\n  Card,\n} from 'x';\n\nBody.\n",
    );
    expect(html.trim()).toBe('<p>Body.</p>');
  });

  it('keeps `export` inside a fence, where it is a shell example', () => {
    const { html } = mdx('```bash\nexport FIELDKIT_API_KEY=fk_live\n```\n');
    expect(html).toContain('FIELDKIT_API_KEY');
  });

  it('keeps a paragraph whose second line happens to start with the word', () => {
    // ESM cannot interrupt a paragraph, which is also how MDX reads it.
    expect(mdx('You can\nimport surveys from a file.\n').html).toContain('import surveys');
  });
});

describe('a component on a line of its own', () => {
  const tabs = [
    '<Tabs syncKey="language">',
    '  <TabItem label="Python">',
    '  ```python',
    'fk = Fieldkit()',
    '',
    'print(fk)',
    '  ```',
    '  </TabItem>',
    '  <TabItem label="TypeScript">',
    '    ```typescript',
    '    const fk = new Fieldkit()',
    '    ```',
    '  </TabItem>',
    '</Tabs>',
    '',
  ].join('\n');

  it('parses its content as Markdown, a blank line inside a fence included', () => {
    // The shape that broke: an HTML block ended at the fence's blank line, and
    // the rest of the sample came out as paragraphs.
    const { html } = mdx(tabs);
    expect(html).toContain('<pre><code class="language-python">');
    expect(html).toMatch(/fk = Fieldkit\(\)\n\n<span[^>]*>print<\/span>\(fk\)/);
    expect(html).not.toContain('&lt;');
  });

  it('reads indentation as layout, never as indented code', () => {
    const { html } = mdx(tabs);
    expect(html).toContain('<pre><code class="language-typescript">');
    expect(html).not.toContain('```');
  });

  it('draws tabs as labelled panels, and keeps the sync key in a closed alphabet', () => {
    const { html } = mdx(tabs.replace('"language"', `'Lang"><b>'`));
    expect(html).toContain(`<div class="spr-tabs" ${TABS_SYNC_ATTR}="lang-b-">`);
    expect(html).toContain('<div class="spr-tab"><p class="spr-tab-label">Python</p>');
    expect(html.match(/class="spr-tab"/g)).toHaveLength(2);
  });

  it('is not closed by a tag inside a fence, which is an example of one', () => {
    const { html } = mdx('<Aside>\n```mdx\n</Aside>\n```\nStill inside.\n</Aside>\n\nOutside.\n');
    expect(html).toMatch(/Still inside\.<\/p>\n<\/div>\n<p>Outside\./);
  });

  it('nests a component inside one of the same name', () => {
    const { html } = mdx(
      '<Tabs>\n<TabItem label="a">\n<Tabs>\n<TabItem label="b">\nInner\n</TabItem>\n</Tabs>\n</TabItem>\n</Tabs>\n',
    );
    expect(html.match(/<div class="spr-tabs">/g)).toHaveLength(2);
    expect(html).toMatch(/Inner<\/p>\n<\/div>\n<\/div>\n<\/div>\n<\/div>/);
  });

  it('closes a paragraph it follows with no blank line between', () => {
    const { html } = mdx('<Aside type="tip">\nOne line.\n</Aside>\n');
    expect(html).toContain('<p>One line.</p>\n</div>');
  });

  it('changes nothing in a `.md` file', () => {
    expect(md(tabs).html).not.toContain('spr-tabs');
    expect(md('import x from "y";\n').html).toContain('import x');
  });
});

describe('the components it knows', () => {
  it('draws an Aside exactly as the directive with the same name', () => {
    const aside = mdx('<Aside type="caution">\nCareful.\n</Aside>\n').html;
    const directive = mdx(':::caution\nCareful.\n:::\n').html;
    expect(aside).toBe(directive);
  });

  it("takes an Aside's title as text, and an unknown type as a note", () => {
    const { html } = mdx('<Aside type="sideways" title="**A** <i>title</i>">\nx\n</Aside>\n');
    expect(html).toContain(
      '<div class="spr-callout spr-callout-note"><p class="spr-callout-label">**A** &lt;i&gt;title&lt;/i&gt;</p>',
    );
  });

  it('wraps the list Steps and FileTree are written as', () => {
    expect(mdx('<Steps>\n\n1. One\n2. Two\n\n</Steps>\n').html).toMatch(
      /^<div class="spr-procedure">\n<ol>/,
    );
    expect(mdx('<FileTree>\n- src/\n  - a.ts\n</FileTree>\n').html).toMatch(
      /^<div class="spr-file-tree">\n<ul>/,
    );
  });

  it('draws a grid of link cards exactly as a folder listing draws its children', () => {
    // One markup, so a template that restyles the listing restyles these too.
    const { html } = mdx(
      [
        '<CardGrid>',
        '\t<LinkCard',
        '\t\ttitle="Surveys"',
        '\t\thref="surveys.md"',
        '\t\tdescription="Question types."',
        '\t/>',
        '\t<LinkCard title="Exports" href="exports.md" />',
        '</CardGrid>',
        '',
      ].join('\n'),
    );
    expect(html).toBe(
      '<ul class="spr-listing spr-cards">\n' +
        '<li><a href="/r/surveys.md">Surveys</a><p>Question types.</p></li>\n' +
        '<li><a href="/r/exports.md">Exports</a></li>\n' +
        '</ul>\n',
    );
  });

  it('draws a content card as an entry of the same list, its body Markdown', () => {
    const { html } = mdx(
      '<CardGrid>\n    <Card title="Sync" icon="rocket">\n        Body with `code`.\n\n        - a list\n    </Card>\n</CardGrid>\n',
    );
    expect(html).toBe(
      '<ul class="spr-listing spr-cards">\n' +
        '<li class="spr-card"><p class="spr-card-title">Sync</p>\n' +
        '<p>Body with <code>code</code>.</p>\n<ul>\n<li>a list</li>\n</ul>\n' +
        '</li>\n</ul>\n',
    );
  });

  it('gives a card outside a grid a one-row list of its own', () => {
    const { html } = mdx(
      '<LinkCard title="Alone" href="a.md" />\n\n<Card title="Solo">\nText.\n</Card>\n',
    );
    expect(html.match(/<ul class="spr-listing spr-cards spr-cards-rows">/g)).toHaveLength(2);
    expect(html).toMatch(/<li class="spr-card">[\s\S]*?<\/li>\n<\/ul>\n$/);
  });

  it('refuses a dangerous href on a card or a button, as on any link', () => {
    const card = mdx('<LinkCard title="x" href="javascript:alert(1)" />\n').html;
    const button = mdx('<LinkButton href="javascript:alert(1)">Go</LinkButton>\n').html;
    expect(card + button).not.toMatch(/javascript/i);
  });

  it('draws a Badge inline, and names only the variants it knows', () => {
    const { html } = mdx(
      'Ohio <Badge text="Preview" variant="caution" /> and <Badge text="x" variant="evil" />\n',
    );
    expect(html).toContain('<span class="spr-chip spr-chip-caution">Preview</span>');
    expect(html).toContain('<span class="spr-chip">x</span>');
  });

  it('keeps a Badge out of the heading id it sits beside', () => {
    const { html } = mdx('## Moving <Badge text="Not supported" variant="danger" />\n');
    expect(html).toContain('<h2 id="moving">');
  });

  it('draws a LinkButton as a link', () => {
    const { html } = mdx('<LinkButton href="cli.md" variant="secondary">CLI</LinkButton>\n');
    expect(html).toContain('<p><a class="spr-link-button" href="/r/cli.md">CLI</a></p>');
  });

  it('draws nothing for an Icon, which is decoration', () => {
    const { html, mdxComponents } = mdx('<Icon name="information" /> Quotas.\n');
    expect(html.trim()).toBe('<p> Quotas.</p>');
    expect(mdxComponents).toEqual([]);
  });

  it('draws Code as the fence carrying the same text', () => {
    const viaComponent = mdx('<Code code={`a = 1\nb = "x"`} lang="toml" title="f.toml" />\n');
    const viaFence = mdx('```toml\na = 1\nb = "x"\n```\n');
    expect(viaComponent.html).toBe(viaFence.html);
  });

  it('cannot draw Code whose text is a variable, and says so', () => {
    const { html, mdxExpressions } = mdx('<Code code={example} lang="ts" />\n');
    expect(html).toBe('');
    expect(mdxExpressions).toEqual(['{example}']);
  });

  it('reports none of its own components as unknown', () => {
    for (const name of KNOWN_COMPONENTS) {
      const { mdxComponents } = mdx(`<${name}>\nx\n</${name}>\n\n<${name} />\n`);
      expect(mdxComponents).toEqual([]);
    }
  });
});

describe('what it cannot draw', () => {
  it('keeps the content of an unknown component, drops its tags, and reports it once', () => {
    const { html, mdxComponents } = mdx(
      '<Hero>\nInside **here**.\n</Hero>\n\n<Hero />\n\nInline <Hero>too</Hero>.\n',
    );
    expect(html).toContain('<p>Inside <strong>here</strong>.</p>');
    expect(html).toContain('<p>Inline too.</p>');
    expect(html).not.toMatch(/hero/i);
    expect(mdxComponents).toEqual(['Hero']);
  });

  it('leaves an expression out and reports it; a comment is left out silently', () => {
    const { html, mdxExpressions } = mdx(
      '{/* TODO: proxy */}\n\nA {props.count} B.\n\n<Fragment set:html={diagram} />\n',
    );
    expect(html.trim()).toBe('<p>A  B.</p>');
    expect(mdxExpressions).toEqual(['{props.count}', '{diagram}']);
  });

  it('reads an unpaired tag in prose as the text it plainly is', () => {
    // SDK reference pages write generic types outside code. MDX would refuse to
    // build them; dropping the type name would be worse than showing it.
    const { html, mdxComponents } = mdx('Returns a Promise<Device> or a Stream<Uint8Array>>.\n');
    expect(html).toContain('Returns a Promise&lt;Device&gt; or a Stream&lt;Uint8Array&gt;&gt;.');
    expect(mdxComponents).toEqual([]);
  });

  it('leaves tags and braces in code alone', () => {
    const { html, mdxExpressions } = mdx('`<Tabs>` and `{x}`\n\n```\n<Tabs>\n{x}\n```\n');
    expect(html).toContain('<code>&lt;Tabs&gt;</code> and <code>{x}</code>');
    expect(html).toContain('<pre><code>&lt;Tabs&gt;\n{x}\n</code></pre>');
    expect(mdxExpressions).toEqual([]);
  });
});
