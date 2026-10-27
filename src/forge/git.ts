/** Mirror repositories and inspect Git refs, commits, and files */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { env } from '../common/env';
import { CodedError } from '../common/errors';
import { makeTempDir, sweepAbandonedTempDirs } from '../common/temp-dir';

const run = promisify(execFile);

export interface GitOptions {
  /** Authenticated URL for clone and fetch */
  authenticatedUrl: string;

  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export const MIRROR_ROOT = env('SPEICHER_MIRROR_ROOT');

const DEFAULT_TIMEOUT = 120_000;

const BASE_ENV = {
  ...process.env,
  // Disable credential prompts and system config
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
      throw new GitError(
        'git.timed-out',
        `Git ${args[0]} timed out after ${timeoutMs / 1000}s.`,
        args[0],
      );
    }
    // Redact credentials before exposing errors
    const message = redactUrls((err as Error).message ?? String(err));
    throw new GitError('git.failed', `Git ${args[0]} failed: ${message}`, args[0]);
  }
}

/** List remote refs and commits without fetching */
export async function lsRemote(options: GitOptions, refs: string[]): Promise<string> {
  return git(
    ['ls-remote', '--symref', options.authenticatedUrl, ...refs],
    undefined,
    options.timeoutMs,
    options.env,
  );
}

/** Replace HTTPS URL credentials with `***` */
export function redactUrls(text: string): string {
  return text.replace(/https:\/\/[^@\s]+@/g, 'https://***@');
}

/** Git failure codes */
export type GitCode =
  | 'git.failed'
  | 'git.timed-out'
  | 'git.transport-unsupported'
  | 'git.empty-repository';

/** Git failure with an optional subcommand name */
export class GitError extends CodedError<GitCode> {
  constructor(
    code: GitCode,
    message: string,
    readonly command: string | null = null,
  ) {
    super(code, message);
  }
}

/** No commits to sync */
export class EmptyRepositoryError extends GitError {
  constructor() {
    super('git.empty-repository', 'Repository has no commits to sync.');
  }
}

/**
 * Clone missing mirrors or update with fetch --prune
 * Remove corrupt mirrors after fetch failures so retries reclone
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

/** Clone into a staging directory, then rename to avoid exposing partial clones */
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

// --git-dir prevents searching parent directories
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

/** Remove abandoned clone staging directories */
export async function sweepAbandonedClones(root = MIRROR_ROOT): Promise<string[]> {
  const removed: string[] = [];
  const forges = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const forge of forges) {
    if (!forge.isDirectory()) continue;
    removed.push(...(await sweepAbandonedTempDirs(join(root, forge.name))));
  }
  return removed;
}

/** Resolve a branch to its commit SHA; throw EmptyRepositoryError if no refs exist */
export async function resolveHead(mirrorDir: string, branch: string): Promise<string> {
  try {
    return await git(['rev-parse', `refs/heads/${branch}`], mirrorDir);
  } catch (err) {
    const anyRef = await git(['for-each-ref', '--count=1'], mirrorDir).catch(() => 'unknown');
    if (anyRef === '') throw new EmptyRepositoryError();
    throw err;
  }
}

/** Replace targetDir with a commit snapshot using git archive and tar */
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
        if (err) reject(new Error(`Could not export commit: ${redactUrls(err.message)}`));
      },
    );
    const tar = execFile('tar', ['-x', '-C', targetDir], { env: BASE_ENV }, (err) => {
      if (err) reject(new Error(`Could not extract files: ${err.message}`));
      else resolvePromise();
    });
    archive.stdout?.pipe(tar.stdin!);
  });
}

/** List changed paths between commits; return [] if fromSha is null */
export async function changedPaths(
  mirrorDir: string,
  fromSha: string | null,
  toSha: string,
): Promise<string[]> {
  if (!fromSha) return [];
  const out = await git(['diff', '--name-only', `${fromSha}..${toSha}`], mirrorDir);
  return out.split('\n').filter(Boolean);
}

/** Get the commit author's email, or null if unavailable */
export async function commitAuthorEmail(mirrorDir: string, sha: string): Promise<string | null> {
  const out = await git(['show', '-s', '--format=%ae', sha], mirrorDir).catch(() => '');
  return out || null;
}

/** Get the branch HEAD points to, or null if unavailable */
export async function defaultBranchOf(mirrorDir: string): Promise<string | null> {
  const out = await git(['symbolic-ref', '--short', 'HEAD'], mirrorDir).catch(() => '');
  return out || null;
}
