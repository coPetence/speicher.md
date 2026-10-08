/**
 * Microsoft Entra ID directory through the Graph API
 *
 * Resolves emails to user IDs, checks subject existence, counts transitive group
 * members
 * Uses OAuth client-credentials flow with configurable tenant and app registration
 * Results cache with a configurable TTL to reduce API calls
 */
import { parseDurationWithFallback } from '../../common/time';
import { Logger, rootLogger } from '../../common/logger';
import { DirectoryUnavailableError } from '../../ingest/grants';
import { DirectoryConfig } from '../../config/types';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const LOGIN_AUTHORITY = 'https://login.microsoftonline.com';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 20_000;

const UNAVAILABLE_COOLDOWN_MS = 60_000;

const TOKEN_SKEW_MS = 60_000; // Subtracted from expires_in to avoid clock-edge races

const PROBE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DirectoryStatus {
  level: 'ok' | 'fail';
  label: string;
  detail: string;
}

export interface GraphDirectoryDeps {
  fetch?: FetchLike;

  sleep?: (ms: number) => Promise<void>;
  now?: () => number;

  graphBase?: string;
  authority?: string;
}

interface CacheEntry {
  value: unknown;
  expires: number;
}

export class GraphDirectory {
  private readonly log: Logger;
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly graphBase: string;
  private readonly authority: string;
  private readonly ttlMs: number;

  private readonly cache = new Map<string, CacheEntry>();
  private token: { value: string; expires: number } | null = null;
  private probed: { status: DirectoryStatus; expires: number } | null = null;
  private unavailableUntil = 0;

  constructor(
    readonly providerId: string,
    private readonly config: DirectoryConfig,
    deps: GraphDirectoryDeps = {},
  ) {
    this.log = rootLogger.child('directory');
    this.fetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => Date.now());
    this.graphBase = deps.graphBase ?? GRAPH_BASE;
    this.authority = deps.authority ?? LOGIN_AUTHORITY;
    this.ttlMs = parseDurationWithFallback(config.cache_ttl, '1h');
  }

  /** Look up a user by email, returning their object ID, or null if not found */
  async resolveEmail(email: string): Promise<string | null> {
    return this.cached(`email:${email}`, async () => {
      // First try the email as a userPrincipalName, then as a mail attribute
      const direct = await this.get(`/users/${encodeURIComponent(email)}?$select=id`);
      if (direct !== null) return idOf(direct);

      // Escape single quotes for OData filter syntax
      const filter = encodeURIComponent(`mail eq '${email.replace(/'/g, "''")}'`);
      const found = await this.get(`/users?$filter=${filter}&$select=id&$top=2`);
      const rows = Array.isArray((found as { value?: unknown[] } | null)?.value)
        ? ((found as { value: Record<string, unknown>[] }).value ?? [])
        : [];
      if (rows.length === 1) return idOf(rows[0]);
      if (rows.length > 1) {
        this.log.warn(
          'address matches more than one directory account; treating it as unresolved',
          {
            provider: this.providerId,
          },
        );
      }
      return null;
    });
  }

  /** True if the subject exists in the directory and is enabled */
  async subjectExists(subject: string): Promise<boolean> {
    return this.cached(`subject:${subject}`, async () => {
      const user = await this.get(
        `/users/${encodeURIComponent(subject)}?$select=id,accountEnabled`,
      );
      if (user === null) return false;
      return (user as { accountEnabled?: boolean }).accountEnabled !== false;
    });
  }

  /**
   * Transitive member count of a group, or null if the group is unknown
   *
   * Swallow directory failures so the admin UI shows unknown size rather than
   * an error page
   */
  async groupSize(groupId: string): Promise<number | null> {
    try {
      return await this.cached(`group:${groupId}`, async () => {
        const body = await this.text(
          `/groups/${encodeURIComponent(groupId)}/transitiveMembers/$count`,
          {
            ConsistencyLevel: 'eventual',
          },
        );
        if (body === null) return null;
        const count = Number(body.trim());
        return Number.isFinite(count) ? count : null;
      });
    } catch (err) {
      // Swallow directory failures so the admin UI shows unknown size not an error
      if (err instanceof DirectoryUnavailableError) return null;
      throw err;
    }
  }

  /** Test the directory connection, returning a status object */
  async probe(): Promise<DirectoryStatus> {
    const held = this.probed;
    if (held && held.expires > this.now()) return held.status;

    const status = await this.attemptProbe();
    this.probed = { status, expires: this.now() + PROBE_TTL_MS };
    return status;
  }

  /** Always try to probe, even during a failure cooldown */
  private async attemptProbe(): Promise<DirectoryStatus> {
    this.unavailableUntil = 0;
    try {
      const found = await this.get('/users?$top=1&$select=id', PROBE_TIMEOUT_MS);
      return found === null
        ? {
            level: 'fail',
            label: 'Not connected',
            detail: 'The directory answered, but not with a user list.',
          }
        : { level: 'ok', label: 'Connected', detail: '' };
    } catch (err) {
      return {
        level: 'fail',
        label: 'Not connected',
        detail:
          err instanceof DirectoryUnavailableError
            ? [err.reason, err.detail ? `(${err.detail.replace(/\.$/, '')})` : '']
                .filter(Boolean)
                .join(' ')
            : 'The directory could not be reached.',
      };
    }
  }

  /** Return the cached value for key, or compute and cache it */
  private async cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expires > this.now()) return hit.value as T;

    const value = await compute();

    this.cache.set(key, { value, expires: this.now() + this.ttlMs });
    return value;
  }

  /** GET request returning parsed JSON, or null on 404 or 400 */
  private async get(path: string, timeoutMs?: number): Promise<unknown | null> {
    const response = await this.send(path, {}, timeoutMs);
    if (response === null) return null;
    return (await response.json()) as unknown;
  }

  /** GET request returning raw text, or null on 404 or 400 */
  private async text(path: string, headers: Record<string, string>): Promise<string | null> {
    const response = await this.send(path, headers);
    if (response === null) return null;
    return await response.text();
  }

  /** Execute a Graph API request with retry and status-specific error handling */
  private async send(
    path: string,
    headers: Record<string, string>,
    timeoutMs?: number,
  ): Promise<Response | null> {
    this.assertAvailable();
    const token = await this.accessToken(timeoutMs);

    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetch(`${this.graphBase}${path}`, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...headers },
          ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        });
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) {
          // Network errors are retried with exponential backoff
          await this.sleep(backoffFor(attempt));
          continue;
        }
        throw this.unavailable('directory unreachable', (err as Error).message);
      }

      if (response.ok) return response;
      if (response.status === 404) return null;

      // Graph returns 400 for invalid userPrincipalName; treat as not found
      if (response.status === 400) return null;

      if (response.status === 401 || response.status === 403) {
        // Not retried; wrong credentials will not become right
        throw this.unavailable(
          'directory refused the credentials',
          `status ${response.status}: the app registration needs the application ` +
            `permissions User.Read.All and GroupMember.Read.All, admin-consented`,
        );
      }

      if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
        // Respect Retry-After header; fall back to exponential backoff
        await this.sleep(retryAfterMs(response) ?? backoffFor(attempt));
        continue;
      }

      throw this.unavailable('directory request failed', `status ${response.status}`);
    }
  }

  /** Return a valid OAuth token, fetching a new one if the cached token is near expiry */
  private async accessToken(timeoutMs?: number): Promise<string> {
    const held = this.token;
    if (held && held.expires > this.now()) return held.value;

    const body = new URLSearchParams({
      client_id: this.config.client_id ?? '',
      client_secret: this.config.client_secret ?? '',
      grant_type: 'client_credentials',
      scope: GRAPH_SCOPE,
    });

    let response: Response;
    try {
      response = await this.fetch(
        `${this.authority}/${encodeURIComponent(this.config.tenant_id ?? '')}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        },
      );
    } catch (err) {
      throw this.unavailable('directory token endpoint unreachable', (err as Error).message);
    }

    if (!response.ok) {
      throw this.unavailable('directory token request failed', `status ${response.status}`);
    }

    const json = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw this.unavailable('directory token response carried no token', '');

    this.token = {
      value: json.access_token,
      expires: this.now() + Math.max(0, (json.expires_in ?? 3600) * 1000 - TOKEN_SKEW_MS),
    };
    return json.access_token;
  }

  /** Throw if the directory is in its failure cooldown period */
  private assertAvailable(): void {
    if (this.now() < this.unavailableUntil) {
      throw new DirectoryUnavailableError(this.providerId, 'still in the failure cooldown');
    }
  }

  /** Enter the failure cooldown, log the first error, and return an error object */
  private unavailable(message: string, detail: string): DirectoryUnavailableError {
    const first = this.now() >= this.unavailableUntil;
    this.unavailableUntil = this.now() + UNAVAILABLE_COOLDOWN_MS;
    this.token = null;
    if (first) {
      this.log.error(`${message}; grants will resolve as they do without a directory`, {
        provider: this.providerId,
        detail,
      });
    }
    return new DirectoryUnavailableError(this.providerId, message, detail);
  }
}

/** Build an Azure portal URL for a group, or empty string if the ID is malformed */
export function entraPortalGroupUrl(groupId: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(groupId)) return '';
  return (
    'https://portal.azure.com/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/' +
    groupId
  );
}

function idOf(user: unknown): string | null {
  const id = (user as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** Exponential backoff with jitter, capped at MAX_BACKOFF_MS */
function backoffFor(attempt: number): number {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.random() * ceiling;
}

/** Parse the Retry-After header in milliseconds, or null if absent or unparseable */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}
