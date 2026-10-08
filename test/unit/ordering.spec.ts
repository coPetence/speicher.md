import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import { walkRepo } from '../../src/ingest/walk/walk';

let config: ConfigService;
let root: string;

beforeAll(() => {
  config = new ConfigService(loadInstanceConfigFromFile(process.env.SPEICHER_CONFIG as string));
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'speicher-ordering-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, contents: string): void {
  const target = join(root, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, contents);
}

function repo(): void {
  write('.speicher.yaml', 'version: 1\naccess:\n  groups: [engineering]\ningest_root: docs\n');
}

function page(relative: string, position?: number | string): void {
  const frontmatter = position === undefined ? '' : `sidebar_position: ${position}\n`;
  write(relative, `---\n${frontmatter}---\n\n# ${relative}\n`);
}

const walk = () =>
  walkRepo({
    workingTree: root,
    config,
    repo: { namespace: 'copetence', slug: 'handbook' },
    now: new Date('2026-08-22T00:00:00Z'),
  });

async function orders(): Promise<Record<string, number | null>> {
  const result = await walk();
  expect(result.findings.rejections).toEqual([]);
  const out: Record<string, number | null> = {};
  for (const doc of result.documents) if (!doc.isIndex) out[doc.slugPath] = doc.sortOrder;
  for (const folder of result.folders)
    if (folder.slugPath !== '') out[folder.slugPath] = folder.sortOrder;
  return out;
}

describe('the numeric prefix stays the native mechanism', () => {
  it('orders by the prefix and strips it from the slug', async () => {
    repo();
    page('docs/02-setup.md');
    page('docs/01-intro.md');

    expect(await orders()).toEqual({ intro: 1, setup: 2 });
  });

  it('wins over an imported key anywhere in the same folder', async () => {
    repo();
    page('docs/01-intro.md');
    page('docs/setup.md', 0);

    expect(await orders()).toEqual({ intro: 1, setup: null });
  });

  it('warns once for the folder, counting the siblings it ignored', async () => {
    repo();
    page('docs/01-intro.md');
    page('docs/setup.md', 2);
    page('docs/reference.md', 3);

    const { findings } = await walk();
    const mixed = findings.all.filter((f) => f.code === 'mixed-ordering');
    expect(mixed).toHaveLength(1);
    expect(mixed[0].severity).toBe('warn');
    expect(mixed[0].source).toBe('docs');
    expect(mixed[0].message).toContain('2 siblings are ignored');
  });

  it('says nothing when a folder carries only one signal', async () => {
    repo();
    page('docs/01-intro.md');
    page('docs/02-setup.md');
    page('docs/guides/a.md', 1);

    const { findings } = await walk();
    expect(findings.all.filter((f) => f.code === 'mixed-ordering')).toEqual([]);
  });
});

describe('the imported keys, where no sibling carries a prefix', () => {
  it("reads Docusaurus's sidebar_position", async () => {
    repo();
    page('docs/reference.md', 3);
    page('docs/intro.md', 1);
    page('docs/setup.md', 2);

    expect(await orders()).toEqual({ intro: 1, setup: 2, reference: 3 });
  });

  it("reads Starlight's sidebar.order, and ignores the rest of that block", async () => {
    repo();
    write(
      'docs/cli.md',
      '---\nsidebar:\n  label: Fieldkit CLI\n  order: 1\n  badge: New\n---\n\n# CLI\n',
    );
    write('docs/api.md', '---\nsidebar:\n  order: 2\n---\n\n# API\n');

    const result = await walk();
    expect(result.findings.all.filter((f) => f.code === 'unknown-key')).toEqual([]);
    expect(await orders()).toEqual({ cli: 1, api: 2 });
  });

  it('ranks rather than stores, so a fractional insert lands between its neighbours', async () => {
    repo();
    page('docs/a.md', 1);
    page('docs/b.md', 2.5);
    page('docs/c.md', 3);

    expect(await orders()).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('keeps siblings that declared the same number tied', async () => {
    repo();
    page('docs/b.md', 1);
    page('docs/a.md', 1);
    page('docs/z.md', 2);

    expect(await orders()).toEqual({ a: 1, b: 1, z: 2 });
  });

  it('leaves a sibling that declared nothing unordered', async () => {
    repo();
    page('docs/first.md', 1);
    page('docs/unranked.md');

    expect(await orders()).toEqual({ first: 1, unranked: null });
  });

  it('orders a subfolder by its landing page, in the same set as the pages', async () => {
    repo();
    page('docs/overview.md', 1);
    page('docs/guides/index.md', 2);
    page('docs/guides/deep.md', 1);
    page('docs/reference.md', 3);

    expect(await orders()).toEqual({
      overview: 1,
      guides: 2,
      reference: 3,
      'guides/deep': 1,
    });
  });
});

describe('the scope is the folder, which is what removes the precedence rule', () => {
  it('lets a prefixed folder sit above an imported one', async () => {
    repo();
    page('docs/01-intro.md');
    page('docs/02-guides/index.md');
    page('docs/02-guides/b.md', 1);
    page('docs/02-guides/a.md', 2);

    expect(await orders()).toEqual({
      intro: 1,
      guides: 2,
      'guides/b': 1,
      'guides/a': 2,
    });
  });

  it('does not let a parent prefix suppress a child folder', async () => {
    repo();
    page('docs/01-intro.md');
    page('docs/guides/a.md', 2);
    page('docs/guides/b.md', 1);

    const result = await orders();
    expect(result['guides/a']).toBe(2);
    expect(result['guides/b']).toBe(1);
    expect(result.guides).toBeNull();
  });

  it('leaves an index page out of its own folder ranking', async () => {
    repo();
    page('docs/guides/index.md', 5);
    page('docs/guides/a.md', 1);

    const result = await walk();
    const landing = result.documents.find((d) => d.slugPath === 'guides');
    expect(landing?.isIndex).toBe(true);
    expect(landing?.sortOrder).toBeNull();
    expect(result.folders.find((f) => f.slugPath === 'guides')?.sortOrder).toBe(1);
  });
});

describe('a four-digit name is not a sort key', () => {
  it('serves both years rather than rejecting one as a collision', async () => {
    repo();
    page('docs/2023-annual-report.md');
    page('docs/2024-annual-report.md');

    const result = await walk();
    expect(result.findings.rejections).toEqual([]);
    expect(result.documents.map((d) => d.slugPath).sort()).toEqual([
      '2023-annual-report',
      '2024-annual-report',
    ]);
  });

  it('keeps the year in the title rather than sorting by it', async () => {
    repo();
    write('docs/2024-06-release.md', '# 2024-06 release\n');

    const result = await walk();
    const doc = result.documents[0];
    expect(doc.sortOrder).toBeNull();
    expect(doc.slugPath).toBe('2024-06-release');
  });

  it('still does the one job the numeric parse exists for', async () => {
    repo();
    page('docs/9-nine.md');
    page('docs/10-ten.md');

    expect(await orders()).toEqual({ nine: 9, ten: 10 });
  });
});
