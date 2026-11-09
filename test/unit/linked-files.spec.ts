import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import type { CommitTree } from '../../src/forge/git';
import { walkRepo } from '../../src/ingest/walk/walk';

let config: ConfigService;
let root: string;

beforeAll(() => {
  config = new ConfigService(loadInstanceConfigFromFile(process.env.SPEICHER_CONFIG as string));
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'speicher-linked-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, contents: string): void {
  const target = join(root, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, contents);
}

/** A commit holding the given files that are not checked out yet, recording each download */
function commitWith(files: Record<string, string>): CommitTree & { requests: string[][] } {
  const requests: string[][] = [];
  return {
    workingTree: root,
    paths: Object.keys(files),
    requests,
    checkout: async (paths) => {
      if (paths.length === 0) return;
      requests.push(paths);
      for (const path of paths) write(path, files[path]);
    },
  };
}

const walk = (commit?: CommitTree) =>
  walkRepo({
    workingTree: root,
    config,
    repo: { namespace: 'copetence', slug: 'handbook' },
    now: new Date('2026-08-22T00:00:00Z'),
    commit,
  });

const brokenLinks = (result: Awaited<ReturnType<typeof walk>>) =>
  result.findings.all.filter((f) => f.code === 'broken-link').map((f) => f.message);

const ROOT_CONFIG = 'version: 1\naccess:\n  groups: [engineering, commercial]\ningest_root: docs\n';

describe('a file a page links to', () => {
  it('is downloaded although no include pattern matches it', async () => {
    write('.speicher.yaml', ROOT_CONFIG);
    write('docs/index.md', '# Home\n\n![Scan](assets/scan.bmp)\n');
    const commit = commitWith({ 'docs/assets/scan.bmp': 'bmp' });

    const result = await walk(commit);

    expect(commit.requests).toEqual([['docs/assets/scan.bmp']]);
    expect(result.assets.map((a) => a.sourcePath)).toEqual(['docs/assets/scan.bmp']);
    expect(brokenLinks(result)).toEqual([]);
  });

  it('is downloaded in one request for all pages', async () => {
    write('.speicher.yaml', ROOT_CONFIG);
    write('docs/index.md', '# Home\n\n![A](a.png)\n');
    write('docs/other.md', '# Other\n\n![B](b.png)\n\n[A again](a.png)\n');
    const commit = commitWith({ 'docs/a.png': 'a', 'docs/b.png': 'b' });

    await walk(commit);

    expect(commit.requests).toHaveLength(1);
    expect([...commit.requests[0]].sort()).toEqual(['docs/a.png', 'docs/b.png']);
  });

  it('is not downloaded again when the include already checked it out', async () => {
    write('.speicher.yaml', ROOT_CONFIG);
    write('docs/index.md', '# Home\n\n![A](a.png)\n');
    write('docs/a.png', 'a');
    const commit = commitWith({ 'docs/a.png': 'a' });

    const result = await walk(commit);

    expect(commit.requests).toEqual([]);
    expect(result.assets.map((a) => a.sourcePath)).toEqual(['docs/a.png']);
  });

  it('is reported as broken when an exclude pattern matches it', async () => {
    write('.speicher.yaml', `${ROOT_CONFIG}sync:\n  exclude: ['**/*.psd']\n`);
    write('docs/index.md', '# Home\n\n[Source](design.psd)\n');
    const commit = commitWith({ 'docs/design.psd': 'psd' });

    const result = await walk(commit);

    expect(commit.requests).toEqual([]);
    expect(result.assets).toEqual([]);
    expect(brokenLinks(result)).toEqual(['broken internal link "docs/design.psd"']);
  });

  it('is reported as broken when the commit does not hold it', async () => {
    write('.speicher.yaml', ROOT_CONFIG);
    write('docs/index.md', '# Home\n\n![Gone](gone.png)\n');
    const commit = commitWith({});

    const result = await walk(commit);

    expect(commit.requests).toEqual([]);
    expect(brokenLinks(result)).toEqual(['broken internal link "docs/gone.png"']);
  });

  it('is readable by the folder it lies in, although that folder holds no pages', async () => {
    write('.speicher.yaml', ROOT_CONFIG);
    write('docs/index.md', '# Home\n');
    write('docs/private/.speicher.yaml', 'access:\n  groups: [commercial]\n');
    write('docs/private/index.md', '# Private\n\n![Plan](img/plan.png)\n');
    const commit = commitWith({ 'docs/private/img/plan.png': 'png' });

    const result = await walk(commit);

    const principalsOf = (sourcePath: string) =>
      result.documents.find((d) => d.sourcePath === sourcePath)!.principals;
    const [asset] = result.assets;
    expect(asset.sourcePath).toBe('docs/private/img/plan.png');
    expect(asset.principals).toEqual(principalsOf('docs/private/index.md'));
    expect(asset.principals).not.toEqual(principalsOf('docs/index.md'));
  });

  it('is not published from a folder whose config is rejected', async () => {
    write('.speicher.yaml', ROOT_CONFIG);
    write('docs/bad/.speicher.yaml', 'ingest_root: elsewhere\n');
    write('docs/index.md', '# Home\n\n![Leak](bad/leak.png)\n');
    const commit = commitWith({ 'docs/bad/leak.png': 'png' });

    const result = await walk(commit);

    expect(commit.requests).toEqual([]);
    expect(result.assets).toEqual([]);
  });
});
