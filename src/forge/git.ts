/**
 * Git operations for mirroring and inspecting repositories
 *
 * Mirrors are kept under MIRROR_ROOT and managed with `--mirror` clones
 * A mirror exists if its HEAD file is present, and is updated with `fetch --prune`
 * Env vars disable prompts and system config to keep automation reliable
 *
 * Credentials in error messages are redacted before propagation
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { env } from '../common/env';

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
    // Strip credentials from the error before exposing it
    const message = redactUrls((err as Error).message ?? String(err));
    throw new Error(`git ${args[0]} failed: ${message}`);
  }
}

/** Replace embedded credentials in HTTPS URLs with `***` */
export function redactUrls(text: string): string {
  return text.replace(/https:\/\/[^@\s]+@/g, 'https://***@');
}

/**
 * Clone or update a bare mirror at mirrorDir
 *
 * Creates the directory and runs `clone --mirror` if HEAD does not exist
 * Otherwise runs `fetch --prune` to stay current
 */
export async function ensureMirror(mirrorDir: string, options: GitOptions): Promise<void> {
  const exists = await fs
    .stat(join(mirrorDir, 'HEAD'))
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    await fs.mkdir(mirrorDir, { recursive: true });
    await git(
      ['clone', '--mirror', options.authenticatedUrl, mirrorDir],
      undefined,
      options.timeoutMs,
      options.env,
    );
    return;
  }

  await git(
    ['fetch', '--prune', '--quiet', options.authenticatedUrl, '+refs/*:refs/*'],
    mirrorDir,
    options.timeoutMs,
    options.env,
  );
}

/** Resolve a branch name to its commit SHA in the mirror */
export async function resolveHead(mirrorDir: string, branch: string): Promise<string> {
  return git(['rev-parse', `refs/heads/${branch}`], mirrorDir);
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
