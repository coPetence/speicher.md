/**
 * Resolve OAuth client metadata via the Client Identifier Metadata Document scheme
 *
 * The client_id is an HTTPS document URL; the document declares redirect URIs and
 * display name. A client_id that is not an HTTPS URL is rejected unless explicitly
 * allowed. The document is cached in-process for ten minutes
 *
 * Fetch is aborted after five seconds and documents over 64 KiB are rejected
 *
 * Not OAuth's client metadata endpoint: a scheme where a client hosts its own
 * metadata at its claimed URL
 */

import { Logger, rootLogger } from '../../common/logger';

const FETCH_TIMEOUT_MS = 5_000;

const CACHE_TTL_MS = 10 * 60_000;

const MAX_DOCUMENT_BYTES = 64 * 1024;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CimdDeps {
  fetch?: FetchLike;
  now?: () => number;

  allowInsecureClientId?: boolean; // Permits http: client_id URLs
}

export interface ClientMetadata {
  clientId: string;
  clientName: string | null;
  clientUri: string | null;
  redirectUris: string[];
}

export class CimdError extends Error {}

interface CacheEntry {
  value: ClientMetadata;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

export function resetCimdCache(): void {
  cache.clear();
}

const log: Logger = rootLogger.child('auth.cimd');

const EMPTY_DEPS: CimdDeps = {};

export async function resolveClientMetadata(
  clientId: string,
  deps: CimdDeps = EMPTY_DEPS,
): Promise<ClientMetadata> {
  const now = deps.now ?? (() => Date.now());
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);

  const injected = deps !== EMPTY_DEPS;
  const memoised = injected ? undefined : cache.get(clientId);
  if (memoised && memoised.expires > now()) return memoised.value;

  const url = parseClientId(clientId, deps.allowInsecureClientId === true);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(url.toString(), {
      headers: { accept: 'application/json' },
      signal: controller.signal,
      redirect: 'error',
    });
  } catch (err) {
    // Fetch threw (network error, abort, or redirect)
    throw new CimdError(`could not fetch client metadata: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new CimdError(`client metadata document answered ${response.status}`);
  }

  const body = await response.text();
  if (body.length > MAX_DOCUMENT_BYTES) {
    throw new CimdError('client metadata document is too large');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new CimdError('client metadata document is not JSON');
  }

  const value = readMetadata(clientId, parsed);
  if (!injected) cache.set(clientId, { value, expires: now() + CACHE_TTL_MS });
  log.info('resolved client metadata document', {
    client_id: clientId,
    redirect_uris: value.redirectUris.length,
  });
  return value;
}

function parseClientId(clientId: string, allowInsecure: boolean): URL {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new CimdError('client_id is not a URL');
  }
  if (url.protocol !== 'https:' && !allowInsecure) {
    throw new CimdError('client_id must be an https URL');
  }
  if (url.hash !== '') throw new CimdError('client_id must not carry a fragment');
  return url;
}

function readMetadata(clientId: string, parsed: unknown): ClientMetadata {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CimdError('client metadata document is not an object');
  }
  const doc = parsed as Record<string, unknown>;

  if (typeof doc.client_id === 'string' && doc.client_id !== clientId) {
    throw new CimdError('client metadata document names a different client_id');
  }

  const redirectUris = Array.isArray(doc.redirect_uris)
    ? doc.redirect_uris.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (redirectUris.length === 0) {
    throw new CimdError('client metadata document declares no redirect_uris');
  }

  return {
    clientId,
    clientName: typeof doc.client_name === 'string' ? doc.client_name : null,
    clientUri: typeof doc.client_uri === 'string' ? doc.client_uri : null,
    redirectUris,
  };
}

export function redirectUriAllowed(requested: string, declared: string[]): boolean {
  let oauthCallbackUrl: URL;
  try {
    oauthCallbackUrl = new URL(requested);
  } catch {
    return false;
  }
  return declared.some((entry) => {
    let currentUrl: URL;
    try {
      currentUrl = new URL(entry);
    } catch {
      return false;
    }
    if (isLoopback(oauthCallbackUrl) && isLoopback(currentUrl)) {
      // Loopback URIs compare only on pathname per OAuth 2.0 Security BCP
      return oauthCallbackUrl.pathname === currentUrl.pathname;
    }
    return oauthCallbackUrl.href === currentUrl.href;
  });
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

export const CIMD_DEPS = Symbol('CIMD_DEPS');
