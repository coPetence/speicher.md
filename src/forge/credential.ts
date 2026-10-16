import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { makeTempDir } from '../common/temp-dir';

/**
 * Credential material for a git remote
 */
export interface GitCredential {
  /** Private SSH key in PEM format */
  deployKey?: string;
  /** Pinned server keys in ssh-keyscan format */
  knownHosts?: string;
  /** Access token (PAT, OAuth, or installation token) */
  token?: string;
  /** Username for the URL; defaults to x-access-token */
  username?: string;
}

/**
 * Arguments passed to the fetch callback
 */
export interface GitInvocation {
  /** URL with credentials embedded, for git to clone or fetch */
  authenticatedUrl: string;
  /** Environment variables; set only for SSH remotes */
  env?: Record<string, string>;
}

/**
 * Materialise credentials and invoke the fetch callback
 *
 * HTTPS embeds the token in the URL; SSH writes key and known_hosts to temp files
 * Other transports are refused to avoid accidental exposure
 */
export async function withGitCredential<T>(
  url: string,
  credential: GitCredential,
  run: (invocation: GitInvocation) => Promise<T>,
): Promise<T> {
  if (url.startsWith('https://')) {
    return run({ authenticatedUrl: httpsUrl(url, credential) });
  }
  if (!url.startsWith('ssh://')) {
    // Only ssh and https support credential injection
    throw new Error(`unsupported git transport in ${url.split('://')[0]}://`);
  }

  const dir = await makeTempDir('git-cred');
  try {
    // Write credentials as files, mode 0600, so only this process reads them
    const keyPath = join(dir, 'deploy_key');
    await fs.writeFile(keyPath, terminated(credential.deployKey ?? ''), { mode: 0o600 });
    const hostsPath = join(dir, 'known_hosts');
    await fs.writeFile(hostsPath, terminated(credential.knownHosts ?? ''), { mode: 0o600 });

    return await run({
      authenticatedUrl: url,
      env: { GIT_SSH_COMMAND: sshCommand(keyPath, hostsPath) },
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * GIT_SSH_COMMAND that offers only the given key and pins the host key
 *
 * IdentitiesOnly=yes prevents agent keys from bypassing a revoked deploy key
 * StrictHostKeyChecking=yes avoids TOFU; BatchMode=yes prevents hanging on passphrase
 */
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

/** Embed credentials into an HTTPS URL; returns unchanged when there is no token */
export function httpsUrl(url: string, credential: GitCredential): string {
  if (!credential.token) return url;
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(credential.username ?? 'x-access-token');
  parsed.password = encodeURIComponent(credential.token);
  return parsed.toString();
}

/** Ensure the value ends with a newline; files need it */
function terminated(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

/** Single-quote a shell argument, escaping embedded quotes */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
