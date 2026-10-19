/**
 * Temporary directories that survive a killed process only until the next worker starts
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rootLogger } from './logger';

const PREFIX = 'speicher-tmp-';
const log = rootLogger.child('temp-dir');

/** Make a temporary directory named after this process and the label */
export function makeTempDir(label: string, root = tmpdir()): Promise<string> {
  return fs.mkdtemp(join(root, `${PREFIX}${process.pid}-${label}-`));
}

/**
 * Remove the temporary directories of processes that no longer run.
 */
export async function sweepAbandonedTempDirs(root = tmpdir()): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await fs.readdir(root)) {
    if (!name.startsWith(PREFIX)) continue;
    const pid = Number(name.slice(PREFIX.length).split('-')[0]);
    // the sweep runs at startup, so any directory with the same pid as our current process belongs to an earlier process with the same pid
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isRunning(pid)) continue;
    try {
      await fs.rm(join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      log.warn('could not remove an abandoned temporary directory', {
        directory: name,
        error: (err as Error).message,
      });
    }
  }
  return removed;
}

function isRunning(pid: number): boolean {
  try {
    // check if the process exists (kill only sends a signal, it does not actually kill the process)
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
