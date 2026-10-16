import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { makeTempDir, sweepAbandonedTempDirs } from '../../src/common/temp-dir';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'speicher-sweep-test-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// The id of a process that has already exited
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

describe('a temporary directory', () => {
  it('is named after the process that made it and its label', async () => {
    const dir = await makeTempDir('42', root);

    expect(dirname(dir)).toBe(root);
    expect(basename(dir)).toMatch(new RegExp(`^speicher-tmp-${process.pid}-42-`));
  });
});

describe('the sweep when a worker starts', () => {
  it('removes what a killed process left, and keeps what a running one still uses', async () => {
    const dead = `speicher-tmp-${deadPid()}-42-abc`;
    const running = `speicher-tmp-${process.ppid}-42-abc`;
    const ownEarlier = `speicher-tmp-${process.pid}-42-abc`;
    const malformed = 'speicher-tmp-garbage';
    const unrelated = 'speicher-mirrors-abc';
    for (const name of [dead, running, ownEarlier, malformed, unrelated]) {
      mkdirSync(join(root, name, 'docs'), { recursive: true });
    }

    const removed = await sweepAbandonedTempDirs(root);

    expect(removed.sort()).toEqual([dead, ownEarlier, malformed].sort());
    expect(readdirSync(root).sort()).toEqual([running, unrelated].sort());
  });
});
