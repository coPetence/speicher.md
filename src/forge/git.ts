/**
 * Git operations for mirroring and inspecting repositories
 *
 * Mirrors are kept under MIRROR_ROOT and managed with `--mirror` clones
 * A mirror exists if git accepts it as a repository, and is updated with `fetch --prune`
 * Env vars disable prompts and system config to keep automation reliable
 *
 * Credentials in error messages are redacted before propagation
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { env } from '../common/env';
import { makeTempDir, sweepAbandonedTempDirs } from '../common/temp-dir';

const run = promisify(execFile);

export interface GitOptions {
  /** URL that includes authentication (used both for clone and fetch) */
  authenticatedUrl: string;

  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export const MIRROR_ROOT = env('SPEICHER_MIRROR_ROOT');

const DEFAULT_TIMEOUT = 120_000;

const BASE_ENV = {
  ...process.env,
  // Disable interactive credential prompts and system-level config that could hang or vary
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: process.env.HOME ?? '/tmp',
};

async function git(
  args: string[],
  cwd?: string,
  timeoutMs = DEFAULT_TIMEOUT,
  extraEnv?: Record<string, string>,
): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      env: { ...BASE_ENV, ...extraEnv },
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    if ((err as { killed?: boolean }).killed) {
      throw new Error(`git ${args[0]} failed: timed out after ${timeoutMs / 1000} seconds`);
    }
    // Strip credentials from the error before exposing it
    const message = redactUrls((err as Error).message ?? String(err));
    throw new Error(`git ${args[0]} failed: ${message}`);
  }
}

/**
 * lsRemote lists refs of a remote and their commits. It fetches nothing.
 * @param options the remote with its credentials
 * @param refs the refs to list, e.g. `HEAD`
 */
export async function lsRemote(options: GitOptions, refs: string[]): Promise<string> {
  return git(
    ['ls-remote', '--symref', options.authenticatedUrl, ...refs],
    undefined,
    options.timeoutMs,
    options.env,
  );
}

/** Replace embedded credentials in HTTPS URLs with `***` */
export function redactUrls(text: string): string {
  return text.replace(/https:\/\/[^@\s]+@/g, 'https://***@');
}

/** The repository has no commits yet, so there is nothing to sync */
export class EmptyRepositoryError extends Error {
  constructor() {
    super('the repository has no commits yet');
    this.name = 'EmptyRepositoryError';
  }
}

/**
 * Clone or update a bare mirror at mirrorDir
 *
 * Clones when git does not accept mirrorDir as a repository, otherwise runs `fetch --prune`
 * A fetch that fails on a mirror `git fsck` finds damaged removes the mirror, so the next attempt clones it afresh
 */
export async function ensureMirror(mirrorDir: string, options: GitOptions): Promise<void> {
  if (!(await isRepository(mirrorDir))) {
    await cloneMirror(mirrorDir, options);
    return;
  }

  try {
    await git(
      ['fetch', '--prune', '--quiet', options.authenticatedUrl, '+refs/*:refs/*'],
      mirrorDir,
      options.timeoutMs,
      options.env,
    );
  } catch (err) {
    if (!(await isIntact(mirrorDir))) await fs.rm(mirrorDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Clone into a directory beside the mirror and rename it into place once complete, so a mirror that exists is always a finished clone. A process killed mid-clone leaves only the temporary directory, which the next worker to start removes
 */
async function cloneMirror(mirrorDir: string, options: GitOptions): Promise<void> {
  await fs.rm(mirrorDir, { recursive: true, force: true });
  await fs.mkdir(dirname(mirrorDir), { recursive: true });
  const staging = await makeTempDir('clone', dirname(mirrorDir));
  try {
    await git(
      ['clone', '--mirror', options.authenticatedUrl, staging],
      undefined,
      options.timeoutMs,
      options.env,
    );
    await fs.rename(staging, mirrorDir).catch(async (err: NodeJS.ErrnoException) => {
      const taken = err.code === 'ENOTEMPTY' || err.code === 'EEXIST';
      if (!taken || !(await isRepository(mirrorDir))) throw err;
    });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

// --git-dir stops git from searching parent directories for a repository instead
async function isRepository(mirrorDir: string): Promise<boolean> {
  return git(['--git-dir', mirrorDir, 'rev-parse', '--git-dir']).then(
    () => true,
    () => false,
  );
}

async function isIntact(mirrorDir: string): Promise<boolean> {
  return git(['fsck', '--connectivity-only', '--no-dangling', '--no-progress'], mirrorDir).then(
    () => true,
    () => false,
  );
}

/** Remove the clones that a killed process left unfinished beside the mirrors */
export async function sweepAbandonedClones(root = MIRROR_ROOT): Promise<string[]> {
  const removed: string[] = [];
  const forges = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const forge of forges) {
    if (!forge.isDirectory()) continue;
    removed.push(...(await sweepAbandonedTempDirs(join(root, forge.name))));
  }
  return removed;
}

/**
 * Resolve a branch name to its commit SHA in the mirror
 * Throws EmptyRepositoryError when the mirror has no refs at all
 */
export async function resolveHead(mirrorDir: string, branch: string): Promise<string> {
  try {
    return await git(['rev-parse', `refs/heads/${branch}`], mirrorDir);
  } catch (err) {
    const anyRef = await git(['for-each-ref', '--count=1'], mirrorDir).catch(() => 'unknown');
    if (anyRef === '') throw new EmptyRepositoryError();
    throw err;
  }
}

/**
 * Extract a commit's tree into targetDir via `git archive | tar -x`
 *
 * Not `git checkout` because the mirror is bare and the target is ephemeral
 * Removes targetDir first so the result is a clean snapshot
 */
export async function checkoutTree(
  mirrorDir: string,
  sha: string,
  targetDir: string,
): Promise<void> {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  await new Promise<void>((resolvePromise, reject) => {
    const archive = execFile(
      'git',
      ['archive', '--format=tar', sha],
      { cwd: mirrorDir, env: BASE_ENV, maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' },
      (err) => {
        if (err) reject(new Error(`git archive failed: ${redactUrls(err.message)}`));
      },
    );
    const tar = execFile('tar', ['-x', '-C', targetDir], { env: BASE_ENV }, (err) => {
      if (err) reject(new Error(`tar failed: ${err.message}`));
      else resolvePromise();
    });
    archive.stdout?.pipe(tar.stdin!);
  });
}

/** Names of files changed between two commits, empty list when fromSha is null */
export async function changedPaths(
  mirrorDir: string,
  fromSha: string | null,
  toSha: string,
): Promise<string[]> {
  if (!fromSha) return [];
  const out = await git(['diff', '--name-only', `${fromSha}..${toSha}`], mirrorDir);
  return out.split('\n').filter(Boolean);
}

/** Author email of a commit, or null if the commit does not exist */
export async function commitAuthorEmail(mirrorDir: string, sha: string): Promise<string | null> {
  const out = await git(['show', '-s', '--format=%ae', sha], mirrorDir).catch(() => '');
  return out || null;
}

/** Name of the branch that HEAD points to in the mirror, or null */
export async function defaultBranchOf(mirrorDir: string): Promise<string | null> {
  const out = await git(['symbolic-ref', '--short', 'HEAD'], mirrorDir).catch(() => '');
  return out || null;
}
