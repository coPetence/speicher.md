import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfig } from '../../src/config/parser';
import { checkoutCommit } from '../../src/forge/git';
import { checkoutIncludedFiles } from '../../src/ingest/select';

const INSTANCE = `
version: 1
auth:
  providers:
    entra:
      type: oidc
      issuer: https://login.example.test/v2.0
      client_id: abc
groups:
  engineering:
    - { provider: entra, id: "grp-eng" }
admins:
  groups: [engineering]
`;

function git(args: string[], cwd: string): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=fixture@speicher.test', '-c', 'user.name=Fixture', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } },
  ).trim();
}

const temporary: string[] = [];

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** Commit the files, check out what the config includes, and list the files that arrived */
async function downloaded(files: Record<string, string>, instance = INSTANCE): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), 'speicher-select-test-'));
  temporary.push(root);
  const origin = join(root, 'origin');
  const target = join(root, 'target');
  mkdirSync(target);
  mkdirSync(origin);
  git(['init', '--quiet', '--initial-branch=main'], origin);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(origin, path)), { recursive: true });
    writeFileSync(join(origin, path), body);
  }
  git(['add', '-A'], origin);
  git(['commit', '--quiet', '-m', 'initial'], origin);

  const config = new ConfigService(loadInstanceConfig(instance));
  await checkoutCommit(
    { authenticatedUrl: `file://${origin}` },
    git(['rev-parse', 'HEAD'], origin),
    target,
    (tree) => checkoutIncludedFiles(tree, config),
  );
  return readdirSync(target, { recursive: true, encoding: 'utf8' })
    .filter((path) => statSync(join(target, path)).isFile())
    .sort();
}

describe('the files a sync downloads', () => {
  it('are Markdown and images by default, without READMEs or code', async () => {
    expect(
      await downloaded({
        '.speicher.yaml': 'version: 1\n',
        'README.md': '# Repo\n',
        'guide.md': '# Guide\n',
        'intro.mdx': '# Intro\n',
        'img/diagram.png': 'png',
        'img/photo.jpg': 'jpg',
        'img/logo.svg': '<svg/>',
        'img/scan.bmp': 'bmp',
        'src/main.ts': 'export {};\n',
      }),
    ).toEqual([
      '.speicher.yaml',
      'guide.md',
      'img/diagram.png',
      'img/logo.svg',
      'img/photo.jpg',
      'intro.mdx',
    ]);
  });

  it('follow the instance defaults until the root config sets its own include', async () => {
    const instance = `${INSTANCE}defaults:\n  sync:\n    include: ['**/*.md']\n`;
    const files = {
      '.speicher.yaml': 'version: 1\n',
      'guide.md': '# Guide\n',
      'scan.bmp': 'bmp',
    };

    expect(await downloaded(files, instance)).toEqual(['.speicher.yaml', 'guide.md']);
    expect(
      await downloaded(
        { ...files, '.speicher.yaml': "version: 1\nsync:\n  include: ['**/*.bmp']\n" },
        instance,
      ),
    ).toEqual(['.speicher.yaml', 'scan.bmp']);
  });

  it('stay inside ingest_root, apart from a cover the root config names', async () => {
    expect(
      await downloaded({
        '.speicher.yaml': 'version: 1\ningest_root: docs\ndisplay:\n  cover: assets/cover.png\n',
        'assets/cover.png': 'png',
        'assets/other.png': 'png',
        'notes.md': '# Not in docs\n',
        'docs/index.md': '# Docs\n',
      }),
    ).toEqual(['.speicher.yaml', 'assets/cover.png', 'docs/index.md']);
  });

  it('follow a folder config that replaces include and adds to exclude', async () => {
    expect(
      await downloaded({
        '.speicher.yaml': 'version: 1\n',
        'guides/.speicher.yaml': "sync:\n  include: ['**/*.md']\n  exclude: ['guides/old/**']\n",
        'guides/setup.md': '# Setup\n',
        'guides/shot.png': 'png',
        'guides/old/legacy.md': '# Legacy\n',
        'other/shot.png': 'png',
      }),
    ).toEqual(['.speicher.yaml', 'guides/.speicher.yaml', 'guides/setup.md', 'other/shot.png']);
  });

  it('leave out everything below a folder config that does not validate', async () => {
    expect(
      await downloaded({
        '.speicher.yaml': 'version: 1\n',
        'guides/.speicher.yaml': 'ingest_root: elsewhere\n',
        'guides/setup.md': '# Setup\n',
        'other.md': '# Other\n',
      }),
    ).toEqual(['.speicher.yaml', 'guides/.speicher.yaml', 'other.md']);
  });

  it('are only the root config files when the root config does not validate', async () => {
    expect(
      await downloaded({
        '.speicher.yaml': 'version: 1\ningest_root: ${DOCS}\n',
        'guide.md': '# Guide\n',
      }),
    ).toEqual(['.speicher.yaml']);
  });
});
