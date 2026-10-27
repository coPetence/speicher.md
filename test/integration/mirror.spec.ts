import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EmptyRepositoryError,
  ensureMirror,
  resolveHead,
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
let forgeDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'speicher-mirror-test-'));
  origin = join(root, 'origin');
  mkdirSync(origin);
  git(['init', '--quiet', '--initial-branch=main'], origin);
  writeFileSync(join(origin, 'index.md'), '# Hello\n');
  git(['add', '-A'], origin);
  git(['commit', '--quiet', '-m', 'initial'], origin);
  forgeDir = join(root, 'mirrors', 'gh');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const from = (dir: string) => ({ authenticatedUrl: `file://${dir}` });

describe('a new mirror', () => {
  it('is cloned and resolves the branch', async () => {
    const mirror = join(forgeDir, '1.git');
    await ensureMirror(mirror, from(origin));

    expect(await resolveHead(mirror, 'main')).toBe(git(['rev-parse', 'HEAD'], origin));
  });

  it('leaves nothing behind when the clone fails, neither the mirror nor its staging', async () => {
    const mirror = join(forgeDir, '1.git');

    await expect(ensureMirror(mirror, from(join(root, 'missing')))).rejects.toFailWith(
      'git.failed',
      { command: 'clone' },
    );

    expect(existsSync(mirror)).toBe(false);
    expect(readdirSync(forgeDir)).toEqual([]);
  });

  it('replaces what an older clone left unfinished, rather than fetching into it', async () => {
    const mirror = join(forgeDir, '1.git');
    mkdirSync(join(mirror, 'objects'), { recursive: true });
    writeFileSync(join(mirror, 'HEAD'), '');

    await ensureMirror(mirror, from(origin));

    expect(await resolveHead(mirror, 'main')).toBe(git(['rev-parse', 'HEAD'], origin));
  });
});

describe('an existing mirror', () => {
  it('is removed when a fetch fails on damage of its own, so the next attempt clones it', async () => {
    const mirror = join(forgeDir, '1.git');
    await ensureMirror(mirror, from(origin));
    // What a full disk leaves when it strikes while a ref is written
    git(['pack-refs', '--all'], mirror);
    rmSync(join(mirror, 'packed-refs'));
    mkdirSync(join(mirror, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(mirror, 'refs', 'heads', 'main'), '');

    await expect(ensureMirror(mirror, from(origin))).rejects.toFailWith('git.failed', {
      command: 'fetch',
    });
    expect(existsSync(mirror)).toBe(false);

    await ensureMirror(mirror, from(origin));
    expect(await resolveHead(mirror, 'main')).toBe(git(['rev-parse', 'HEAD'], origin));
  });

  it('is kept when the remote cannot be reached, because the mirror itself is fine', async () => {
    const mirror = join(forgeDir, '1.git');
    await ensureMirror(mirror, from(origin));

    await expect(ensureMirror(mirror, from(join(root, 'missing')))).rejects.toFailWith(
      'git.failed',
      { command: 'fetch' },
    );

    expect(await resolveHead(mirror, 'main')).toBe(git(['rev-parse', 'HEAD'], origin));
  });
});

describe('an empty repository', () => {
  it('is told apart from a branch that does not exist', async () => {
    const empty = join(root, 'empty.git');
    git(['init', '--quiet', '--bare', empty], root);
    const emptyMirror = join(forgeDir, 'empty.git');
    const fullMirror = join(forgeDir, 'full.git');
    await ensureMirror(emptyMirror, from(empty));
    await ensureMirror(fullMirror, from(origin));

    await expect(resolveHead(emptyMirror, 'main')).rejects.toBeInstanceOf(EmptyRepositoryError);
    const missingBranch = await resolveHead(fullMirror, 'trunk').catch((err: Error) => err);
    expect(missingBranch).toBeInstanceOf(Error);
    expect(missingBranch).not.toBeInstanceOf(EmptyRepositoryError);
  });
});

describe('the sweep when a worker starts', () => {
  it('removes a clone a killed process left unfinished beside the mirrors', async () => {
    const mirrors = join(root, 'mirrors');
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const abandoned = join(forgeDir, `speicher-tmp-${deadPid}-clone-abc`);
    mkdirSync(abandoned, { recursive: true });
    await ensureMirror(join(forgeDir, '1.git'), from(origin));

    expect(await sweepAbandonedClones(mirrors)).toEqual([`speicher-tmp-${deadPid}-clone-abc`]);
    expect(readdirSync(forgeDir)).toEqual(['1.git']);
  });
});
