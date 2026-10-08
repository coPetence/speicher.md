/**
 * Token minting and hashing
 *
 * Tokens are base64url-encoded random bytes with a structured prefix
 * Stored as SHA-256 hex hashes; the raw token is shown once to the caller
 * Comparison uses timingSafeEqual to prevent timing attacks on stored hashes
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function mintToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const API_KEY_PREFIX = 'spk_';

export function mintApiKey(): { token: string; hash: string } {
  const token = `${API_KEY_PREFIX}${mintToken(32)}`;
  return { token, hash: hashToken(token) };
}

export const ACCESS_TOKEN_PREFIX = 'spa_';
export const REFRESH_TOKEN_PREFIX = 'spr_';

export function mintPrefixed(prefix: string): { token: string; hash: string } {
  const token = `${prefix}${mintToken(32)}`;
  return { token, hash: hashToken(token) };
}
