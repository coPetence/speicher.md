/**
 * GitHub orgs as directory
 */
import { Logger, rootLogger } from '../../common/logger';
import { backoffMs, parseDurationWithFallback, retryAfterHeaderToMs } from '../../common/time';
import { ConfigService } from '../../config/config.service';
import { DirectoryConfig, GithubProviderConfig } from '../../config/types';
import { githubHosts } from '../../forge/github/hosts';
import { GithubTokenMinter } from '../../forge/github/tokens';
import { DirectoryUnavailableError } from '../../ingest/grants';
import { splitTeam } from './github-config';
import { DirectoryStatus, FetchLike } from './graph';

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 20_000;

const UNAVAILABLE_COOLDOWN_MS = 60_000;

const PAGE_SIZE = 100;

const PROBE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;

// Supported until 10 March 2028
// We use an older version because GitHub Enterprise servers often lag
const API_VERSION = '2022-11-28';

export interface GithubDirectoryDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface CacheEntry {
  value: unknown;
  expires: number;
}

/** One organisation this App is installed on */
interface Installation {
  login: string;
  installationId: string;
}

interface InstallationPayload {
  id: number;
  suspended_at?: string | null;
  account?: { login?: string };
}

export class GithubDirectory {
  private readonly log: Logger;
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly ttlMs: number;

  private readonly cache = new Map<string, CacheEntry>();
  private probed: { status: DirectoryStatus; expires: number } | null = null;
  private unavailableUntil = 0;
  private warnedAboutOrgs = false;

  /** all orgs mentioned in the teamIds */
  private readonly orgs: string[];

  private readonly apiBase: string;
  private readonly minter: GithubTokenMinter;

  constructor(
    readonly providerShortId: string,
    config: DirectoryConfig,
    instance: ConfigService,
    private readonly teamIds: string[], // `org/team-slug`
    deps: GithubDirectoryDeps = {},
  ) {
    this.orgs = [
      ...new Set(
        teamIds.map((id) => splitTeam(id)[0]).filter((org): org is string => org !== null),
      ),
    ];
    this.apiBase = apiBaseOf(
      instance.provider(providerShortId) as GithubProviderConfig | undefined,
    );
    this.minter = new GithubTokenMinter(
      config.app_id ?? '',
      config.private_key ?? '',
      this.apiBase,
      deps.fetch as unknown as typeof fetch,
    );
    this.log = rootLogger.child('directory');
    this.fetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => Date.now());
    this.ttlMs = parseDurationWithFallback(config.cache_ttl, '1h');
  }

  async resolveEmail(_email: string): Promise<undefined> {
    // GitHub doesnt offer us to resolve by email -> always undefined
    return undefined;
  }

  /**
   * Checks if a person is still part of the orgs.
   * GitHub user accounts are independent of orgs, so a user can depart an org and still exist.
   */
  async subjectExists(subject: string): Promise<boolean> {
    return this.cached(`subject:${subject}`, async () => {
      if (this.orgs.length === 0) {
        if (!this.warnedAboutOrgs) {
          this.warnedAboutOrgs = true;
          this.log.warn(
            'no group source names a GitHub team for this provider; make sure you include the team in the group ids (`org/team-slug`)',
            { provider: this.providerShortId },
          );
        }
        return true;
      }

      const orgs = await this.reachable();
      if (orgs.length === 0) throw this.unavailable(...noInstallation(this.orgs.join(', ')));

      const login = await this.loginOf(orgs[0], subject);
      if (login === null) return false;

      for (const org of orgs) {
        const membership = await this.apiGetRequest(
          org,
          `/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(login)}`,
        );
        if ((membership as { state?: string } | null)?.state === 'active') return true;
      }
      return false;
    });
  }

  /**
   * The teams a subject is in
   *
   * Null -> could not say (unreachable)
   */
  async groupsFor(subject: string): Promise<string[] | null> {
    try {
      return await this.cached(`teams:${subject}`, async () => {
        const orgs = await this.reachable();
        if (orgs.length === 0) return null;

        const login = await this.loginOf(orgs[0], subject);

        if (login === null) return [];

        const out: string[] = [];
        for (const teamId of this.teamIds) {
          const [org, slug] = splitTeam(teamId);
          if (org === null || slug === null || !orgs.includes(org)) continue;

          const membership = await this.apiGetRequest(
            org,
            `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/memberships/${encodeURIComponent(login)}`,
          );
          if ((membership as { state?: string } | null)?.state === 'active') out.push(teamId);
        }
        return out;
      });
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return null;
      throw err;
    }
  }

  /**
   * Members of a team
   */
  async groupSize(groupId: string): Promise<number | null> {
    const [org, slug] = splitTeam(groupId);
    if (org === null || slug === null) return null;

    try {
      return await this.cached(`team:${groupId}`, async () => {
        const team = await this.apiGetRequest(
          org,
          `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}`,
        );
        const count = (team as { members_count?: unknown } | null)?.members_count;
        return typeof count === 'number' ? count : null;
      });
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return null;
      throw err;
    }
  }

  async probe(): Promise<DirectoryStatus> {
    const held = this.probed;
    if (held && held.expires > this.now()) return held.status;

    const status = await this.attemptProbe();
    this.probed = { status, expires: this.now() + PROBE_TTL_MS };
    return status;
  }

  private async attemptProbe(): Promise<DirectoryStatus> {
    this.cache.clear();
    this.unavailableUntil = 0;

    if (this.orgs.length === 0) {
      return {
        level: 'fail',
        label: 'Nothing to reach',
        detail:
          'You have no group configured which references a GitHub team; Therefore this configuration has no effect',
      };
    }

    const reachable = await this.reachable();
    if (reachable.length === 0) {
      return {
        level: 'fail',
        label: 'Not connected',
        detail: `${noInstallation(this.orgs.join(', '))[1]}.`,
      };
    }

    const probed = this.teamIds
      .map((id) => splitTeam(id))
      .find(([org, slug]) => org !== null && slug !== null && reachable.includes(org));

    const [org, slug] = probed ?? [reachable[0], null];

    try {
      const found =
        slug === null
          ? await this.apiGetRequest(
              org as string,
              `/orgs/${encodeURIComponent(org as string)}`,
              PROBE_TIMEOUT_MS,
            )
          : await this.apiGetRequest(
              org as string,
              `/orgs/${encodeURIComponent(org as string)}/teams/${encodeURIComponent(slug)}`,
              PROBE_TIMEOUT_MS,
            );

      if (found !== null) return { level: 'ok', label: 'Connected', detail: '' };

      return {
        level: 'fail',
        label: 'Not connected',
        detail:
          slug === null
            ? `The app cannot read "${org}"`
            : `the team "${slug}" cannot be found in "${org}". ` +
              'Either the team does not exist or the App is ' +
              'missing the organisation permission Members: Read-only.',
      };
    } catch (err) {
      return {
        level: 'fail',
        label: 'Not connected',
        detail:
          err instanceof DirectoryUnavailableError
            ? [err.reason, err.detail ? `(${err.detail.replace(/\.$/, '')})` : '']
                .filter(Boolean)
                .join(' ')
            : 'The organisation could not be reached.',
      };
    }
  }

  /** Resolves the user behind a subject id */
  private async loginOf(org: string, subject: string): Promise<string | null> {
    return this.cached(`login:${subject}`, async () => {
      const user = await this.apiGetRequest(org, `/user/${encodeURIComponent(subject)}`);
      const login = (user as { login?: unknown } | null)?.login;
      return typeof login === 'string' && login !== '' ? login : null;
    });
  }

  /**
   * The organisations an app installation actually reaches
   */
  private async reachable(): Promise<string[]> {
    const out: string[] = [];
    for (const org of this.orgs) {
      if ((await this.installationOn(org)) !== null) out.push(org);
    }
    return out;
  }

  /** cached value for key or compute and cache it */
  private async cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expires > this.now()) return hit.value as T;

    const value = await compute();

    this.cache.set(key, { value, expires: this.now() + this.ttlMs });
    return value;
  }

  /** Perform a GET Request to the GitHub API */
  private async apiGetRequest(
    org: string,
    path: string,
    timeoutMs?: number,
  ): Promise<unknown | null> {
    const installationId = await this.installationOn(org);
    if (installationId === null) throw this.unavailable(...noInstallation(org));

    let token: string;
    try {
      token = await this.minter.installationToken(installationId);
    } catch (err) {
      throw this.unavailable('could not mint an installation token', (err as Error).message);
    }

    return this.request(
      path,
      token,
      `the App installed on "${org}" needs the organisation permission Members: Read-only`,
      timeoutMs,
    );
  }

  /**
   * The installation id that reaches this organisation (null when no installation reaches)
   */
  private async installationOn(org: string): Promise<string | null> {
    const key = org.toLowerCase();
    const found = (await this.installations()).find((each) => each.login.toLowerCase() === key);
    return found?.installationId ?? null;
  }

  /**
   * Every organisation this App is installed on
   */
  private async installations(): Promise<Installation[]> {
    return this.cached('installations', async () => {
      let jwt: string;
      try {
        jwt = await this.minter.appJwt();
      } catch (err) {
        throw this.unavailable('the App private key could not be used', (err as Error).message);
      }

      const out: Installation[] = [];
      for (let page = 1; ; page += 1) {
        const batch = (await this.request(
          `/app/installations?per_page=${PAGE_SIZE}&page=${page}`,
          jwt,
          'the app_id and private_key must belong to the same GitHub App',
        )) as InstallationPayload[] | null;
        if (batch === null) return out;

        for (const each of batch) {
          const login = each.account?.login;
          // A suspended installation holds no usable token
          if (login && each.suspended_at === null) {
            out.push({ login, installationId: String(each.id) });
          }
        }
        if (batch.length < PAGE_SIZE) return out;
      }
    });
  }

  private async request(
    path: string,
    token: string,
    hint: string,
    timeoutMs?: number,
  ): Promise<unknown | null> {
    this.assertAvailable();

    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetch(`${this.apiBase}${path}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': API_VERSION,
          },
          ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        });
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(backoffMs(attempt, BASE_BACKOFF_MS, MAX_BACKOFF_MS));
          continue;
        }
        throw this.unavailable('directory unreachable', (err as Error).message);
      }

      if (response.ok) return (await response.json()) as unknown;

      if (response.status === 404) return null;

      if (response.status === 401 || response.status === 403) {
        throw this.unavailable('the App was refused', `status ${response.status}: ${hint}`);
      }

      if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
        await this.sleep(
          retryAfterHeaderToMs(response.headers.get('retry-after')) ??
            backoffMs(attempt, BASE_BACKOFF_MS, MAX_BACKOFF_MS),
        );
        continue;
      }

      throw this.unavailable('directory request failed', `status ${response.status}`);
    }
  }

  /** Throw if the directory is in its failure cooldown period */
  private assertAvailable(): void {
    if (this.now() < this.unavailableUntil) {
      throw new DirectoryUnavailableError(this.providerShortId, 'still in the failure cooldown');
    }
  }

  /** Enter failure cooldown */
  private unavailable(message: string, detail: string): DirectoryUnavailableError {
    const first = this.now() >= this.unavailableUntil;
    this.unavailableUntil = this.now() + UNAVAILABLE_COOLDOWN_MS;
    if (first) {
      this.log.error(`${message}; grants will resolve as they do without a directory`, {
        provider: this.providerShortId,
        detail,
      });
    }
    return new DirectoryUnavailableError(this.providerShortId, message, detail);
  }
}

function noInstallation(orgs: string): [string, string] {
  return [
    'the directory App reaches no such organisation',
    `this provider's directory App is not installed on "${orgs}"; install the App on that organisation first`,
  ];
}

/**
 * API host. Defaults to GitHub API if no base url is specified for the provider
 */
function apiBaseOf(provider: GithubProviderConfig | undefined): string {
  return githubHosts(provider?.base_url).api;
}
