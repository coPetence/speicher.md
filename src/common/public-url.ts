/**
 * Whether an address can be reached from the internet, e.g. by GitHub delivering a webhook
 */

import { BlockList, isIP } from 'node:net';

// Loopback, private networks, shared address space, link-local and unique local addresses
const UNREACHABLE = new BlockList();
UNREACHABLE.addSubnet('0.0.0.0', 8, 'ipv4');
UNREACHABLE.addSubnet('10.0.0.0', 8, 'ipv4');
UNREACHABLE.addSubnet('100.64.0.0', 10, 'ipv4');
UNREACHABLE.addSubnet('127.0.0.0', 8, 'ipv4');
UNREACHABLE.addSubnet('169.254.0.0', 16, 'ipv4');
UNREACHABLE.addSubnet('172.16.0.0', 12, 'ipv4');
UNREACHABLE.addSubnet('192.168.0.0', 16, 'ipv4');
UNREACHABLE.addAddress('::', 'ipv6');
UNREACHABLE.addAddress('::1', 'ipv6');
UNREACHABLE.addSubnet('fc00::', 7, 'ipv6');
UNREACHABLE.addSubnet('fe80::', 10, 'ipv6');

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

// Names that only resolve on this machine or in a local network
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/**
 * isPublicUrl returns whether a URL points at a host that can be reached from the internet.
 * It returns false for `localhost`, for names of a local network such as `speicher.local` or a
 * bare `speicher`, and for loopback and private addresses. It returns false for a URL that cannot be parsed.
 *
 * @param url the URL to check
 */
export function isPublicUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }

  const family = isIP(host);
  if (family !== 0) return !UNREACHABLE.check(host, family === 6 ? 'ipv6' : 'ipv4');

  if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  // A name without a dot, e.g. a container's service name, is only known in its own network
  return host.includes('.');
}

/**
 * isLocalhostUrl returns whether a URL points at this machine
 *
 * @param url the URL to check
 */
export function isLocalhostUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }

  const family = isIP(host);
  if (family !== 0) return LOOPBACK.check(host, family === 6 ? 'ipv6' : 'ipv4');
  return host === 'localhost' || host.endsWith('.localhost');
}

/**
 * webhookReach returns whether GitHub will accept and reach a webhook on a URL.
 * It returns `refused` for localhost, `uncertain` for an address that may not be reachable,
 * and `reachable` otherwise. A GitHub Enterprise Server may run in the same network, so with a base URL only localhost is refused.
 *
 * @param url the webhook URL, or an empty string when it is not known
 * @param baseUrl the base URL of a GitHub Enterprise Server, or an empty string for GitHub.com
 */
export function webhookReach(url: string, baseUrl: string): 'refused' | 'uncertain' | 'reachable' {
  if (isLocalhostUrl(url)) return 'refused';
  return baseUrl !== '' || isPublicUrl(url) ? 'reachable' : 'uncertain';
}
