/**
 * Fetches and reads the SSH host keys of git servers, the lines of `known_hosts`
 *
 * `sshKeyscan` asks a server for its keys. The answer only says which keys the
 * server answering right now claims to have, so a person compares the fingerprints
 * with ones from a trusted source before the keys are saved and trusted
 */

import { execFile } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';

export interface SshHost {
  host: string;
  port: number;
}

export interface HostKey {
  // The host the key belongs to, e.g. `git.example.com` or
  // `[git.example.com]:2222`
  host: string;
  // Key type, e.g. `ssh-ed25519`
  type: string;
  // SHA256 fingerprint in the format `ssh-keygen -l` prints, e.g. `SHA256:+DiY3wv…`
  fingerprint: string;
}

// Asks one server for its host keys and returns the lines it answered with
export type KeyScanner = (target: SshHost) => Promise<string>;

const SCAN_TIMEOUT_SECONDS = 5;

// A host name, IPv4 or IPv6 address. Refuses a leading `-`, which ssh-keyscan
// would read as an option
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9.:-]*$/;

/** The host and port of an `ssh://` URL, or null for any other URL */
export function sshHostOf(url: string): SshHost | null {
  const trimmed = url.trim();
  if (!trimmed.startsWith('ssh://')) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!HOST_NAME.test(host)) return null;
  return { host, port: parsed.port === '' ? 22 : Number(parsed.port) };
}

/** The name `known_hosts` uses for a server: the host alone on port 22, else `[host]:port` */
export function knownHostsName({ host, port }: SshHost): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** The fingerprint of a base64 encoded public key, e.g. `SHA256:+DiY3wv…` */
export function fingerprintOf(base64Key: string): string {
  const digest = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

// True when `base64Key` is a public key of `type`: the decoded key starts with its
// type name, preceded by the name's length as a 4-byte number
function isKeyOfType(type: string, base64Key: string): boolean {
  if (!/^[A-Za-z0-9+/]+=*$/.test(base64Key)) return false;
  const blob = Buffer.from(base64Key, 'base64');
  if (blob.length < 4) return false;
  const length = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + length).toString('latin1') === type;
}

/**
 * The keys in `known_hosts` text, and how many of its lines could not be read.
 * Blank lines and comments are neither
 */
export function readKnownHosts(text: string): { keys: HostKey[]; unreadable: number } {
  const keys: HostKey[] = [];
  let unreadable = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    // A line may start with a marker such as `@cert-authority`
    if (parts[0]?.startsWith('@')) parts.shift();
    const [host, type, key] = parts;
    if (!host || !type || !key || !isKeyOfType(type, key)) {
      unreadable += 1;
      continue;
    }
    keys.push({ host, type, fingerprint: fingerprintOf(key) });
  }
  return { keys, unreadable };
}

/**
 * Whether `text`, the lines of a `known_hosts` file, holds a key for the server
 * `name`, e.g. `git.example.com` or `[git.example.com]:2222`. A line names its servers
 * as a comma-separated list of plain names, hashed names and patterns with `*` and
 * `?`; a pattern starting with `!` excludes the servers it matches. A revoked key and
 * a line whose key cannot be read do not count
 *
 * @param text the `known_hosts` lines
 * @param name the server as `known_hosts` names it, see `knownHostsName`
 */
export function knowsHost(text: string, name: string): boolean {
  return keysOfHost(text, name).length > 0;
}

/**
 * The keys `text`, the lines of a `known_hosts` file, holds for the server `name`, as
 * `<type> <fingerprint>` in sorted order, so that the keys two texts hold for a server
 * can be compared. Which lines count is decided as in `knowsHost`
 *
 * @param text the `known_hosts` lines
 * @param name the server as `known_hosts` names it, see `knownHostsName`
 */
export function keysOfHost(text: string, name: string): string[] {
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts[0] === '@revoked') continue;
    if (parts[0]?.startsWith('@')) parts.shift();
    const [hosts, type, key] = parts;
    if (!hosts || !type || !key || !isKeyOfType(type, key)) continue;
    const patterns = hosts.split(',');
    const excluded = patterns.some(
      (pattern) => pattern.startsWith('!') && matchesHost(pattern.slice(1), name),
    );
    if (!excluded && patterns.some((pattern) => matchesHost(pattern, name))) {
      keys.add(`${type} ${fingerprintOf(key)}`);
    }
  }
  return [...keys].sort();
}

// Whether one entry of a line's server list names `name`: a hashed name
// `|1|<salt>|<hash>`, or a name or pattern compared without regard to case
function matchesHost(pattern: string, name: string): boolean {
  if (pattern.startsWith('!')) return false;
  if (pattern.startsWith('|1|')) {
    const [salt, hash] = pattern.slice('|1|'.length).split('|');
    if (!salt || !hash) return false;
    const hashed = createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64');
    return hashed === hash;
  }
  const glob = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${glob}$`, 'i').test(name);
}

/**
 * Returns the servers of a forge's `ssh://` repositories that its `known_hosts` holds no key
 * for. Empty when `known_hosts` is a reference to an
 * environment variable, whose value is not known here
 *
 * @param forge the forge
 */
export function serversWithoutHostKey(forge: {
  known_hosts?: string;
  repos?: { url: string }[];
}): string[] {
  const text = forge.known_hosts ?? '';
  if (text.includes('${')) return [];
  const names = new Set<string>();
  for (const repo of forge.repos ?? []) {
    const server = sshHostOf(repo.url);
    if (server) names.add(knownHostsName(server));
  }
  return [...names].filter((name) => !knowsHost(text, name));
}

/**
 * Replaces the lines of the servers named in `names` with `scanned`, and keeps the
 * lines of every other server and the comments
 */
export function mergeKnownHosts(text: string, names: string[], scanned: string): string {
  const kept = text.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (trimmed === '') return false;
    if (trimmed.startsWith('#')) return true;
    const parts = trimmed.split(/\s+/);
    if (parts[0]?.startsWith('@')) parts.shift();
    const hosts = (parts[0] ?? '').split(',');
    return !hosts.some((host) => names.includes(host));
  });
  const added = scanned
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .sort();
  return [...kept, ...added].join('\n');
}

/** Asks the server for its host keys with `ssh-keyscan` */
export const sshKeyscan: KeyScanner = (target) =>
  new Promise((resolve, reject) => {
    execFile(
      'ssh-keyscan',
      ['-T', String(SCAN_TIMEOUT_SECONDS), '-p', String(target.port), target.host],
      { timeout: (SCAN_TIMEOUT_SECONDS + 5) * 1000 },
      (error, stdout) => {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
          reject(new Error('ssh-keyscan is not installed on this instance.'));
          return;
        }
        const lines = stdout
          .split('\n')
          .filter((line) => line.trim() !== '' && !line.startsWith('#'));
        if (lines.length === 0) {
          reject(
            new Error(
              `The server ${knownHostsName(target)} did not answer with a host key within ${SCAN_TIMEOUT_SECONDS} seconds.`,
            ),
          );
          return;
        }
        resolve(lines.join('\n'));
      },
    );
  });
