import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  CLONE_ROOT,
  CommitTree,
  EmptyRepositoryError,
  checkoutCommit,
  resolveRemoteHead,
  sweepAbandonedClones,
} from '../../src/forge/git';

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Speicher Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@speicher.test',
  GIT_COMMITTER_NAME: 'Speicher Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@speicher.test',
};

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim();
}

let root: string;
let origin: string;
let target: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'speicher-checkout-test-'));
  origin = join(root, 'origin');
  target = join(root, 'target');
  mkdirSync(origin);
  mkdirSync(target);
  git(['init', '--quiet', '--initial-branch=main'], origin);
  // A local origin only leaves file contents out when it is told to allow it
  git(['config', 'uploadpack.allowFilter', 'true'], origin);
  for (const [path, body] of Object.entries({
    '.speicher.yaml': 'version: 1\n',
    'docs/index.md': '# Hello\n',
    'docs/img/a.png': 'png',
    'src/main.ts': 'export {};\n',
  })) {
    mkdirSync(dirname(join(origin, path)), { recursive: true });
    writeFileSync(join(origin, path), body);
  }
  git(['add', '-A'], origin);
  git(['commit', '--quiet', '-m', 'initial'], origin);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const from = (dir: string) => ({ authenticatedUrl: `file://${dir}` });

describe('the remote head', () => {
  it('is the commit of the configured branch', async () => {
    expect(await resolveRemoteHead(from(origin), 'main')).toEqual({
      branch: 'main',
      sha: git(['rev-parse', 'HEAD'], origin),
    });
  });

  it('is the commit of the branch HEAD points to when no branch is configured', async () => {
    git(['checkout', '--quiet', '-b', 'trunk'], origin);

    expect(await resolveRemoteHead(from(origin), '')).toEqual({
      branch: 'trunk',
      sha: git(['rev-parse', 'HEAD'], origin),
    });
  });

  it('tells an empty repository apart from a branch that does not exist', async () => {
    const empty = join(root, 'empty.git');
    git(['init', '--quiet', '--bare', empty], root);

    await expect(resolveRemoteHead(from(empty), 'main')).rejects.toBeInstanceOf(
      EmptyRepositoryError,
    );
    const missing = await resolveRemoteHead(from(origin), 'docs').catch((err: Error) => err);
    expect(missing).toFailWith('git.failed', { command: 'ls-remote' });
    expect(missing).not.toBeInstanceOf(EmptyRepositoryError);
  });

  it('never puts the token in the error, which reaches /-/status and the admin log', async () => {
    const url = 'https://x-access-token:ghs_supersecrettoken@127.0.0.1:1/copetence/guide.git';

    const error = await resolveRemoteHead({ authenticatedUrl: url }, 'main').catch(
      (err: Error) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('ghs_supersecrettoken');
  });
});

describe('a checkout', () => {
  const sha = () => git(['rev-parse', 'HEAD'], origin);

  it('writes only the files select checks out, and no .git', async () => {
    const commit = await checkoutCommit(from(origin), sha(), target, (tree) =>
      tree.checkout(['.speicher.yaml', 'docs/index.md']),
    );

    expect(readdirSync(target, { recursive: true, encoding: 'utf8' }).sort()).toEqual([
      '.speicher.yaml',
      'docs',
      'docs/index.md',
    ]);
    expect(commit.authorEmail).toBe('fixture@speicher.test');
  });

  it('lists every file of the commit, before any of them is downloaded', async () => {
    let listed: string[] = [];
    await checkoutCommit(from(origin), sha(), target, async (tree) => {
      listed = tree.paths;
    });

    expect(listed.sort()).toEqual([
      '.speicher.yaml',
      'docs/img/a.png',
      'docs/index.md',
      'src/main.ts',
    ]);
    expect(readdirSync(target)).toEqual([]);
  });

  it('does not download the contents of the files it leaves out', async () => {
    let missing = 0;
    await checkoutCommit(from(origin), sha(), target, async (tree: CommitTree) => {
      await tree.checkout(['docs/index.md']);
      const gitDir = readdirSync(CLONE_ROOT).find((name) => name.includes('-clone-'))!;
      missing = git(
        ['--git-dir', join(CLONE_ROOT, gitDir), 'rev-list', '--objects', '--missing=print', sha()],
        root,
      )
        .split('\n')
        .filter((line) => line.startsWith('?')).length;
    });

    expect(missing).toBe(3);
  });

  it('takes a file name with pattern characters literally', async () => {
    writeFileSync(join(origin, 'docs', '*.md'), '# Star\n');
    git(['add', '-A'], origin);
    git(['commit', '--quiet', '-m', 'star'], origin);

    await checkoutCommit(from(origin), sha(), target, (tree) => tree.checkout(['docs/*.md']));

    expect(readdirSync(join(target, 'docs'))).toEqual(['*.md']);
  });

  it('leaves no git data behind, also when select fails', async () => {
    const failure = new Error('select failed');
    await checkoutCommit(from(origin), sha(), target, async () => {});
    await expect(
      checkoutCommit(from(origin), sha(), target, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(readdirSync(CLONE_ROOT).filter((name) => name.includes('-clone-'))).toEqual([]);
  });

  it('refuses something that is not a commit SHA, so it cannot be read as an option', async () => {
    await expect(
      checkoutCommit(from(origin), '--upload-pack=touch', target, async () => {}),
    ).rejects.toFailWith('git.failed', { command: 'fetch' });
  });
});

describe('the sweep when a worker starts', () => {
  it('removes the git data of a stopped process and the mirrors of earlier versions', async () => {
    const clones = join(root, 'clones');
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    mkdirSync(join(clones, `speicher-tmp-${deadPid}-clone-abc`), { recursive: true });
    mkdirSync(join(clones, 'gh', '1.git'), { recursive: true });
    writeFileSync(join(clones, 'gh', '1.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(clones, 'gh', 'notes.git'), { recursive: true });

    expect((await sweepAbandonedClones(clones)).sort()).toEqual([
      'gh/1.git',
      `speicher-tmp-${deadPid}-clone-abc`,
    ]);
    expect(readdirSync(join(clones, 'gh'))).toEqual(['notes.git']);
  });
});
