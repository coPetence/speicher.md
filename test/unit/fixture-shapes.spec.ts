import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The `fieldkit` fixture is synthetic, and it exists to carry shapes a docs team
 * writing for Starlight produces and nobody writing for Speicher would. This is the
 * inventory. `fieldkit.spec.ts` asserts what ingest *does* with each shape; this
 * asserts each shape is still *there*, because the failure it guards against is a
 * tidy-up that removes one and leaves a threshold over there passing for the wrong
 * reason. Read off the files, with no database, so it fails in a second.
 */

const ROOT = join(__dirname, '..', 'fixtures', 'repos', 'fieldkit');
const DOCS = join(ROOT, 'docs');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(DOCS).map((path) => ({
  path: relative(DOCS, path),
  text: readFileSync(path, 'utf8'),
}));

function frontmatterKeys(text: string): string[] {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  return [...block.matchAll(/^([A-Za-z_]+):/gm)].map((m) => m[1]);
}

const containing = (pattern: RegExp) =>
  files.filter((f) => pattern.test(f.text)).map((f) => f.path);

describe('the fieldkit fixture is a Starlight site', () => {
  it('is MDX almost throughout, with one plain Markdown page', () => {
    const md = files.filter((f) => f.path.endsWith('.md')).map((f) => f.path);
    expect(md).toEqual(['404.md']);
    expect(files.length).toBeGreaterThan(25);
  });

  it('spells landing pages as index.mdx, and leaves a nested folder without one', () => {
    const paths = new Set(files.map((f) => f.path));
    for (const index of ['index.mdx', 'python-sdk/index.mdx', 'typescript-sdk/index.mdx']) {
      expect(paths).toContain(index);
    }
    // tree.spec.ts tells a folder with a landing page from one without by these two.
    expect(paths).not.toContain('python-sdk/async/index.mdx');
    expect([...paths].some((p) => p.startsWith('python-sdk/async/'))).toBe(true);
  });

  it("carries frontmatter that belongs to Starlight, not to Speicher's schema", () => {
    const keys = new Set(files.flatMap((f) => frontmatterKeys(f.text)));
    for (const key of [
      'hideTitleOnPage',
      'template',
      'tableOfContents',
      'next',
      'head',
      'hero',
      'pagefind',
      'editUrl',
      'lastUpdated',
      'banner',
    ]) {
      expect(keys).toContain(key);
    }
    expect(containing(/^hideTitleOnPage: true$/m).length).toBeGreaterThan(10);
  });

  it('leaves component imports and tags in the body', () => {
    expect(
      containing(/^import .* from '@astrojs\/starlight\/components';$/m).length,
    ).toBeGreaterThan(3);
    expect(containing(/<TabItem label=/).length).toBeGreaterThan(3);
    expect(containing(/<Fragment set:html=/)).toEqual(['device-management.mdx']);
    expect(containing(/^<Aside /m)).toEqual(['api-keys.mdx', 'tools/cli.mdx']);
    expect(containing(/^<iframe /m)).toEqual(['surveys.mdx']);
  });

  it('uses each Starlight component at least once, in the layouts a docs team writes', () => {
    // fieldkit.spec.ts asserts what each becomes; this keeps each one here.
    for (const name of [
      'Tabs',
      'TabItem',
      'Steps',
      'FileTree',
      'CardGrid',
      'Card',
      'LinkCard',
      'Aside',
      'Badge',
      'LinkButton',
      'Icon',
      'Code',
    ]) {
      expect(containing(new RegExp(`<${name}[\\s>/]`)).length).toBeGreaterThan(0);
    }
    // Indented by tabs, by four spaces, and spread over several lines.
    expect(containing(/^\t<LinkCard$/m)).toEqual(['index.mdx']);
    expect(containing(/^ {4}<Card /m)).toEqual(['python-sdk/index.mdx']);
    // Inline: in a table cell, beside a heading, and in prose.
    expect(containing(/^\|.*<Badge /m)).toEqual(['regions.mdx']);
    expect(containing(/^## .*<Badge /m)).toEqual(['regions.mdx']);
    expect(containing(/^<LinkButton .*<\/LinkButton>$/m)).toEqual(['getting-started.mdx']);
    // A template literal that spans lines, an expression and a comment.
    expect(containing(/<Code code=\{`[^`]*\n/)).toEqual(['configuration.mdx']);
    expect(containing(/^\{\/\*.*\*\/\}$/m)).toEqual(['configuration.mdx']);
    // GitHub's task list and a footnote referenced from a table cell.
    expect(containing(/^- \[x\] /m)).toEqual(['offline-sync.mdx']);
    expect(containing(/^- \[ \] /m)).toEqual(['offline-sync.mdx']);
    expect(containing(/^\|.*\[\^[a-z-]+\]/m)).toEqual(['regions.mdx']);
    expect(containing(/^\[\^[a-z-]+\]: /m)).toEqual(['regions.mdx']);
    // Generic types in prose, which an MDX build would refuse.
    expect(containing(/^[^`\n]*Promise<Device>/m)).toEqual(['typescript-sdk/device.mdx']);
  });

  it('uses every directive kind, and leaves one `:::` that opens nothing', () => {
    for (const kind of ['note', 'tip', 'caution', 'danger']) {
      expect(containing(new RegExp(`^:::${kind}$`, 'm')).length).toBeGreaterThan(0);
    }
    const page = files.find((f) => f.path === 'device-management.mdx')?.text ?? '';
    const opened = (page.match(/^:::[a-z]+$/gm) ?? []).length;
    const closed = (page.match(/^:::$/gm) ?? []).length;
    expect(closed).toBe(opened + 1);
  });

  it('links the way the published site is addressed, and within the page', () => {
    expect(containing(/\]\(\/docs\//).length).toBeGreaterThan(5);
    expect(containing(/\]\(#[a-z-]+\)/).length).toBeGreaterThan(1);
  });

  it('writes the generic type a wikilink rule must leave alone, in code and in emphasis', () => {
    expect(containing(/`[^`\n]*Callable\[\[\], str\][^`\n]*`/).length).toBeGreaterThan(0);
    expect(containing(/_[^_\n]*Callable\[\[\], str\][^_\n]*_/).length).toBeGreaterThan(0);
    expect(containing(/\[\[[^\]]*\]\]/)).toEqual([]);
  });

  it('has one page long enough that a whole response is worth compressing', () => {
    const longest = Math.max(...files.map((f) => Buffer.byteLength(f.text)));
    expect(longest).toBeGreaterThan(10_000);
  });

  it('borrows none of the conventions the handbook fixture exists to test', () => {
    expect(files.filter((f) => /(^|\/)\d{1,3}-/.test(f.path))).toEqual([]);
    for (const key of ['icon', 'redirect_from', 'sidebar_position', 'tags', 'indexable']) {
      expect(containing(new RegExp(`^${key}:`, 'm'))).toEqual([]);
    }
    expect(files.filter((f) => f.path.endsWith('.speicher.yaml'))).toEqual([]);
  });
});
