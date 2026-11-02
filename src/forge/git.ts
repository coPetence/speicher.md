/** Resolve remote heads and check out selected files of one commit */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { env } from '../common/env';
import { CodedError } from '../common/errors';
import { rootLogger } from '../common/logger';
import { makeTempDir, sweepAbandonedTempDirs } from '../common/temp-dir';

export interface GitOptions {
  /** Authenticated URL for ls-remote and fetch */
  authenticatedUrl: string;

  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

/** Directory for the git data of the commits being checked out */
export const CLONE_ROOT = env('SPEICHER_MIRROR_ROOT');

const DEFAULT_TIMEOUT = 120_000;

const log = rootLogger.child('git');

const BASE_ENV = {
  ...process.env,
  // Disable credential prompts and system config
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: process.env.HOME ?? '/tmp',
};

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
}

/** Run git without a limit on its output; reject with a GitError named after the subcommand */
function runGit(
  args: string[],
  options: RunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const command = subcommandOf(args);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: { ...BASE_ENV, ...options.env },
      timeout: timeoutMs,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    // git may exit before it reads all of stdin
    child.stdin.on('error', () => {});
    child.on('error', (err) =>
      reject(new GitError('git.failed', `Git ${command} failed: ${err.message}`, command)),
    );
    child.on('close', (code, signal) => {
      const errorText = redactUrls(Buffer.concat(stderr).toString('utf8').trim());
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: errorText });
      } else if (child.killed) {
        reject(
          new GitError(
            'git.timed-out',
            `Git ${command} timed out after ${timeoutMs / 1000}s.`,
            command,
          ),
        );
      } else {
        const reason = errorText || `exit code ${code ?? signal}`;
        reject(new GitError('git.failed', `Git ${command} failed: ${reason}`, command));
      }
    });
    child.stdin.end(options.input ?? '');
  });
}

/** The git subcommand, after the global options and their values */
function subcommandOf(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (['--git-dir', '--work-tree', '-c'].includes(args[i])) i++;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return args[0];
}

async function git(args: string[], options: RunOptions = {}): Promise<string> {
  return (await runGit(args, options)).stdout.trim();
}

/** List remote refs and commits without fetching */
export async function lsRemote(options: GitOptions, refs: string[]): Promise<string> {
  return git(['ls-remote', '--symref', options.authenticatedUrl, ...refs], {
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
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
 * Resolve a branch on the remote to its commit SHA without downloading anything
 * An empty branch name resolves the branch the remote HEAD points to
 */
export async function resolveRemoteHead(
  options: GitOptions,
  branch: string,
): Promise<{ branch: string; sha: string }> {
  const listing = await lsRemote(options, branch ? ['HEAD', `refs/heads/${branch}`] : ['HEAD']);
  const commits = new Map<string, string>();
  let headBranch = '';
  for (const line of listing.split('\n')) {
    const [left, ref] = line.split('\t');
    if (!ref) continue;
    if (left.startsWith('ref: ')) {
      if (ref === 'HEAD') headBranch = left.slice('ref: refs/heads/'.length);
    } else {
      commits.set(ref, left);
    }
  }
  if (commits.size === 0) throw new EmptyRepositoryError();

  const target = branch || headBranch;
  if (!target) {
    throw new GitError('git.failed', 'The remote HEAD does not point to a branch.', 'ls-remote');
  }
  const sha = commits.get(`refs/heads/${target}`) ?? (branch ? undefined : commits.get('HEAD'));
  if (!sha) {
    throw new GitError(
      'git.failed',
      `The branch "${target}" does not exist on the remote.`,
      'ls-remote',
    );
  }
  return { branch: target, sha };
}

/** The files of one commit, of which only the checked out ones are downloaded */
export interface CommitTree {
  /** Directory the checked out files are written to */
  readonly workingTree: string;
  /** Repo-relative paths of all files in the commit */
  readonly paths: string[];
  /** Download the given files in one request and write them into the working tree */
  checkout(paths: string[]): Promise<void>;
}

export interface CheckedOutCommit {
  authorEmail: string | null;
}

/**
 * Fetch one commit with its trees but no file contents, then let select check out the files it needs
 * The git data is removed afterwards, so only the checked out files remain
 */
export async function checkoutCommit(
  options: GitOptions,
  sha: string,
  workingTree: string,
  select: (tree: CommitTree) => Promise<void>,
): Promise<CheckedOutCommit> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
    throw new GitError('git.failed', `"${sha}" is not a commit SHA.`, 'fetch');
  }
  await fs.mkdir(CLONE_ROOT, { recursive: true });
  const gitDir = await makeTempDir('clone', CLONE_ROOT);
  const run = { env: options.env, timeoutMs: options.timeoutMs };
  try {
    await git(['init', '--quiet', '--bare', gitDir]);
    await git(['--git-dir', gitDir, 'remote', 'add', 'origin', options.authenticatedUrl]);
    const fetched = await runGit(
      [
        '--git-dir',
        gitDir,
        'fetch',
        '--quiet',
        '--depth=1',
        '--filter=blob:none',
        '--no-tags',
        'origin',
        sha,
      ],
      run,
    );
    if (fetched.stderr.includes('filtering not recognized')) {
      log.warn('the remote does not support partial clones and sent every file', { commit: sha });
    }

    const blobs = await listBlobs(gitDir, sha);
    await select({
      workingTree,
      paths: [...blobs.keys()],
      checkout: async (paths) => {
        const wanted = [...new Set(paths)].filter((path) => blobs.has(path));
        if (wanted.length === 0) return;
        await runGit(
          [
            '--git-dir',
            gitDir,
            '-c',
            'fetch.negotiationAlgorithm=noop',
            'fetch',
            '--quiet',
            '--no-tags',
            '--no-write-fetch-head',
            '--recurse-submodules=no',
            '--filter=blob:none',
            '--stdin',
            'origin',
          ],
          { ...run, input: [...new Set(wanted.map((path) => blobs.get(path)))].join('\n') },
        );
        await runGit(
          [
            '--git-dir',
            gitDir,
            '--work-tree',
            workingTree,
            'checkout',
            sha,
            '--pathspec-from-file=-',
            '--pathspec-file-nul',
          ],
          {
            ...run,
            env: { ...options.env, GIT_LITERAL_PATHSPECS: '1' },
            input: wanted.join('\0'),
          },
        );
      },
    });

    const authorEmail = await git(['--git-dir', gitDir, 'show', '-s', '--format=%ae', sha]).catch(
      () => '',
    );
    return { authorEmail: authorEmail || null };
  } finally {
    await fs.rm(gitDir, { recursive: true, force: true });
  }
}

/** Map each file path of a commit to its blob ID; submodules are left out */
async function listBlobs(gitDir: string, sha: string): Promise<Map<string, string>> {
  const { stdout } = await runGit(['--git-dir', gitDir, 'ls-tree', '-r', '-z', '--full-tree', sha]);
  const blobs = new Map<string, string>();
  for (const entry of stdout.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    const [, type, oid] = entry.slice(0, tab).split(' ');
    if (type === 'blob') blobs.set(entry.slice(tab + 1), oid);
  }
  return blobs;
}

/**
 * Remove the git data of stopped processes
 * Also remove the full mirrors that earlier versions kept in `<forge>/<repo>.git`
 */
export async function sweepAbandonedClones(root = CLONE_ROOT): Promise<string[]> {
  const removed = await sweepAbandonedTempDirs(root).catch(() => [] as string[]);
  const forges = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const forge of forges) {
    if (!forge.isDirectory() || forge.name.startsWith('speicher-tmp-')) continue;
    const forgeDir = join(root, forge.name);
    removed.push(...(await sweepAbandonedTempDirs(forgeDir)));
    for (const entry of await fs.readdir(forgeDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('.git')) continue;
      const mirror = join(forgeDir, entry.name);
      const isRepository = await fs.stat(join(mirror, 'HEAD')).then(
        () => true,
        () => false,
      );
      if (!isRepository) continue;
      await fs.rm(mirror, { recursive: true, force: true });
      removed.push(`${forge.name}/${entry.name}`);
    }
  }
  return removed;
}
