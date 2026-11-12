import { promises as fs } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { makeTempDir } from '../common/temp-dir';
import { GitError } from './git';

/** Git remote credentials */
export interface GitCredential {
  /** PEM-encoded SSH private key */
  deployKey?: string;
  /** Trusted host keys in ssh-keyscan format */
  knownHosts?: string;
  /** Access token */
  token?: string;
  /** HTTPS username; defaults to x-access-token */
  username?: string;
}

/** Authenticated Git callback arguments */
export interface GitInvocation {
  /** Clone or fetch URL with HTTPS credentials */
  authenticatedUrl: string;
  /** SSH-only environment variables */
  env?: Record<string, string>;
}

/** Run with HTTPS or SSH credentials, then remove temporary SSH files */
export async function withGitCredential<T>(
  url: string,
  credential: GitCredential,
  run: (invocation: GitInvocation) => Promise<T>,
): Promise<T> {
  if (url.startsWith('https://')) {
    return run({ authenticatedUrl: httpsUrl(url, credential) });
  }
  if (!url.startsWith('ssh://')) {
    // Reject unsupported transports
    throw new GitError(
      'git.transport-unsupported',
      `Unsupported Git transport "${url.split('://')[0]}://". Use HTTPS or SSH.`,
    );
  }

  const dir = await makeTempDir('git-cred');
  try {
    // Restrict credential files to owner access
    const keyPath = join(dir, 'deploy_key');
    await fs.writeFile(keyPath, terminated(credential.deployKey ?? ''), { mode: 0o600 });
    const hostsPath = join(dir, 'known_hosts');
    await fs.writeFile(hostsPath, terminated(credential.knownHosts ?? ''), { mode: 0o600 });

    const env: Record<string, string> = { GIT_SSH_COMMAND: sshCommand(keyPath, hostsPath) };
    if (!hasPasswdEntry()) Object.assign(env, await passwdWrapperEnv(dir));

    return await run({ authenticatedUrl: url, env });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function hasPasswdEntry(): boolean {
  try {
    userInfo();
    return true;
  } catch {
    return false;
  }
}

export async function passwdWrapperEnv(dir: string): Promise<Record<string, string>> {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const passwdPath = join(dir, 'passwd');
  const groupPath = join(dir, 'group');
  await fs.writeFile(passwdPath, `speicher:x:${uid}:${gid}:speicher:${dir}:/usr/sbin/nologin\n`);
  await fs.writeFile(groupPath, `speicher:x:${gid}:\n`);
  return {
    LD_PRELOAD: 'libnss_wrapper.so',
    NSS_WRAPPER_PASSWD: passwdPath,
    NSS_WRAPPER_GROUP: groupPath,
  };
}

/** Build an SSH command using the supplied key, trusted hosts, and no prompts */
export function sshCommand(keyPath: string, knownHostsPath: string): string {
  return [
    'ssh',
    '-i',
    shellQuote(keyPath),
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${shellQuote(knownHostsPath)}`,
    '-o',
    'BatchMode=yes',
  ].join(' ');
}

/** Add HTTPS credentials if a token is provided */
export function httpsUrl(url: string, credential: GitCredential): string {
  if (!credential.token) return url;
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(credential.username ?? 'x-access-token');
  parsed.password = encodeURIComponent(credential.token);
  return parsed.toString();
}

/** Add a trailing newline if missing */
function terminated(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

/** Shell-quote a value, escaping embedded single quotes */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
