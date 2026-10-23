import { LinkKind, renderMarkdown, rewriteMarkdownLinks } from '../../src/ingest/markdown';
import { WIKILINK_ATTR } from '../../src/ingest/wikilinks';

function render(source: string) {
  return renderMarkdown(source, {
    resolveLink: (target, kind) => `/r/${kind}/${target}`,
  });
}

describe('what is a wikilink', () => {
  it('resolves the target and shows it as the link text', () => {
    const { html } = render('See [[guides/vault]].\n');
    expect(html).toContain('<a href="/r/wikilink/guides/vault">guides/vault</a>');
  });

  it('takes an alias after the first pipe, and leaves later ones in the label', () => {
    expect(render('[[vault|the vault]]\n').html).toContain('>the vault</a>');
    expect(render('[[vault|a|b]]\n').html).toContain('>a|b</a>');
  });

  it('keeps a fragment on the target, where `splitTarget` can find it', () => {
    const { html } = render('[[vault#rotation|rotate]]\n');
    expect(html).toContain('<a href="/r/wikilink/vault#rotation">rotate</a>');
  });

  it('passes an in-page link through without asking the resolver', () => {
    expect(render('[[#rotation]]\n').html).toContain('href="#rotation"');
  });

  it("shows the linked page's title when the resolver knows it and there is no alias", () => {
    const titled = (source: string) =>
      renderMarkdown(source, {
        resolveLink: (target) => ({ href: `/r/${target}`, title: 'Shared <env> secrets' }),
      }).html;
    expect(titled('[[../../deployments/shared-env-secrets]]\n')).toContain(
      '<a href="/r/../../deployments/shared-env-secrets">Shared &lt;env&gt; secrets</a>',
    );
    expect(titled('[[shared-env-secrets|the secrets]]\n')).toContain('>the secrets</a>');
    expect(titled('[[shared-env-secrets]]\n')).not.toContain('data-spr-wikilink-title');
  });

  it('never says in the HTML which syntax a link was written in', () => {
    const both = render('[[vault]] and [a](vault.md)\n').html;
    expect(both).not.toContain(WIKILINK_ATTR);
    expect(both).not.toContain('wikilink"');
  });
});

describe('what is not a wikilink', () => {
  it('leaves an inline code span alone', () => {
    const { html } = render('`Callable[[], str]` and `[[vault]]`\n');
    expect(html).not.toContain('<a ');
    expect(html).toContain('[[vault]]');
  });

  it('leaves a fenced block alone', () => {
    const { html } = render('```python\nf: Callable[[], str] = g\n[[vault]]\n```\n');
    expect(html).not.toContain('<a ');
  });

  it('leaves the shape SDK reference docs actually contain alone', () => {
    const { html } = render('- `get_root_dir` _Callable[[], str]_ - a function\n');
    expect(html).not.toContain('<a ');
    expect(html).toContain('[[], str]');
  });

  it('declines an unclosed one, an empty one, and one spanning a line', () => {
    expect(render('[[vault\n').html).not.toContain('<a ');
    expect(render('[[]]\n').html).not.toContain('<a ');
    expect(render('[[vault\nrotation]]\n').html).not.toContain('<a ');
  });

  it('declines a nested bracket rather than guessing where the target ends', () => {
    expect(render('[[a[b]]\n').html).not.toContain('<a ');
  });
});

describe('embeds', () => {
  it('embeds a file as an image', () => {
    const { html } = render('![[images/diagram.png]]\n');
    expect(html).toContain('<img src="/r/image/images/diagram.png"');
    expect(html).toContain('alt=""');
    expect(render('![[images/diagram.png|Architecture]]\n').html).toContain('alt="Architecture"');
  });

  it('renders an embedded page as a link, and says so through the kind', () => {
    const { html } = render('![[guides/vault]]\n');
    expect(html).toContain('<a href="/r/wikiembed/guides/vault">');
    expect(html).not.toContain('<img');
  });

  it('treats an embedded Markdown file as a page, not a file', () => {
    expect(render('![[guides/vault.md]]\n').html).toContain('/r/wikiembed/guides/vault.md');
  });
});

describe('the Markdown an agent is served', () => {
  it('is rewritten too, because `[[x]]` is a string an agent cannot follow', () => {
    const out = rewriteMarkdownLinks(
      'See [[vault|the vault]] and ![[a/b.png]] and [[#top]].\n',
      (target: string, kind: LinkKind) => `/r/${kind}/${target}`,
    );
    expect(out).toContain('[the vault](/r/wikilink/vault)');
    expect(out).toContain('![](/r/image/a/b.png)');
    expect(out).toContain('[#top](#top)');
  });

  it('names a page by its title there too, and keeps brackets in it from ending the link text', () => {
    const out = rewriteMarkdownLinks('[[vault]] and [[vault|the vault]]\n', (target) => ({
      href: `/r/${target}`,
      title: 'Vault [draft]',
    }));
    expect(out).toContain('[Vault \\[draft\\]](/r/vault)');
    expect(out).toContain('[the vault](/r/vault)');
  });

  it('leaves a fenced block alone there as well', () => {
    const out = rewriteMarkdownLinks('```\n[[vault]]\n```\n', () => '/r/x');
    expect(out).toContain('[[vault]]');
  });
});
