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
  root = mkdtempSync(join(tmpdir(), 'speicher-landing-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, contents: string): void {
  const target = join(root, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, contents);
}

function repo(access = 'access:\n  groups: [engineering]\n'): void {
  write('.speicher.yaml', `version: 1\n${access}ingest_root: docs\n`);
}

const walk = () =>
  walkRepo({
    workingTree: root,
    config,
    repo: { namespace: 'copetence', slug: 'handbook' },
    now: new Date('2026-08-22T00:00:00Z'),
  });

describe('a file named after a sibling directory', () => {
  it('becomes that directory index rather than a collision', async () => {
    repo();
    write('docs/guides.md', '# Guides\n');
    write('docs/guides/one.md', '# One\n');

    const result = await walk();
    expect(result.findings.rejections).toEqual([]);

    const landing = result.documents.find((d) => d.slugPath === 'guides');
    expect(landing?.sourcePath).toBe('docs/guides.md');
    expect(landing?.isIndex).toBe(true);
    expect(result.documents.map((d) => d.slugPath).sort()).toEqual(['guides', 'guides/one']);
  });

  it('does not also appear as a sibling page', async () => {
    repo();
    write('docs/guides.md', '# Guides\n');
    write('docs/guides/one.md', '# One\n');

    const result = await walk();
    expect(result.documents.filter((d) => d.slugPath === 'guides')).toHaveLength(1);
    expect(result.documents.some((d) => d.slugPath === 'guides/guides')).toBe(false);
  });

  it('takes the folder access, not its own directory', async () => {
    repo('access:\n  groups: [engineering, commercial]\n');
    write('docs/guides.md', '# Guides\n');
    write('docs/guides/.speicher.yaml', 'access:\n  groups: [commercial]\n');
    write('docs/guides/one.md', '# One\n');

    const result = await walk();
    const landing = result.documents.find((d) => d.slugPath === 'guides');
    const child = result.documents.find((d) => d.slugPath === 'guides/one');
    expect(landing?.principals).toEqual(['group:commercial']);
    expect(child?.principals).toEqual(['group:commercial']);
  });

  it('is unaffected by whether the name sorts before or after the directory', async () => {
    repo();
    write('docs/a.md', '# A\n');
    write('docs/a/inner.md', '# Inner\n');
    write('docs/zz.md', '# Zz\n');
    write('docs/zz/inner.md', '# Inner\n');

    const result = await walk();
    expect(result.findings.rejections).toEqual([]);
    for (const slug of ['a', 'zz']) {
      expect(result.documents.find((d) => d.slugPath === slug)?.isIndex).toBe(true);
    }
  });

  it('rejects both spellings at once, which has no defensible winner', async () => {
    repo();
    write('docs/guides.md', '# From the file\n');
    write('docs/guides/index.md', '# From the folder\n');
    write('docs/guides/one.md', '# One\n');

    const result = await walk();
    const rejection = result.findings.rejections.find((f) => f.code === 'slug-collision');
    expect(rejection).toBeDefined();
    expect(rejection!.message).toContain('claim the landing page');
    expect(result.failedSubtrees).toContain('guides');
  });

  it('still rejects two files whose stripped slugs collide', async () => {
    repo();
    write('docs/01-intro.md', '# One\n');
    write('docs/02-intro.md', '# Two\n');

    const result = await walk();
    expect(result.findings.rejections.map((f) => f.code)).toContain('slug-collision');
  });

  it('still rejects two directories whose slugs collide', async () => {
    repo();
    write('docs/01-guides/a.md', '# A\n');
    write('docs/02-guides/b.md', '# B\n');

    const result = await walk();
    expect(result.findings.rejections.map((f) => f.code)).toContain('slug-collision');
  });
});

describe("the repository's start page without a title or heading", () => {
  const startTitle = async () =>
    (await walk()).documents.find((d) => d.slugPath === '' && d.isIndex)?.title;

  it("is named after the repository's display title", async () => {
    repo('access:\n  groups: [engineering]\ndisplay:\n  title: Engineering Handbook\n');
    write('docs/index.md', 'Welcome.\n');

    expect(await startTitle()).toBe('Engineering Handbook');
  });

  it('is named after the repository when it has no display title', async () => {
    repo();
    write('docs/index.md', 'Welcome.\n');

    expect(await startTitle()).toBe('Handbook');
  });

  it('keeps the heading it has', async () => {
    repo();
    write('docs/index.md', '# Welcome\n');

    expect(await startTitle()).toBe('Welcome');
  });
});
