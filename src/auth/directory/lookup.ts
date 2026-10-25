import { Logger, rootLogger } from '../../common/logger';
import { parseDurationWithFallback } from '../../common/time';
import { ConfigService } from '../../config/config.service';
import { DirectoryConfig, GithubProviderConfig } from '../../config/types';
import { DirectoryLookup, DirectoryUnavailableError } from '../../ingest/grants';

import { GithubDirectory, GithubDirectoryDeps } from './github';
import { DirectoryStatus, GraphDirectory, GraphDirectoryDeps, entraPortalGroupUrl } from './graph';

const log: Logger = rootLogger.child('directory');

export interface Directory {
  resolveEmail(email: string): Promise<string | null | undefined>;
  subjectExists(subject: string): Promise<boolean>;
  groupSize(groupId: string): Promise<number | null>;
  probe(): Promise<DirectoryStatus>;
  groupsFor?(subject: string, options?: { fresh?: boolean }): Promise<string[] | null>;
}

/**
 * Directory lookup across the configured providers
 *
 * Returns undefined from clientFor and true from subjectExists when
 * no directory is configured, so the caller proceeds unconstrained
 */
class Directories implements DirectoryLookup {
  constructor(private readonly byProvider: Map<string, Directory>) {}

  covers(provider: string): boolean {
    return this.byProvider.has(provider);
  }

  clientFor(provider: string): Directory | undefined {
    return this.byProvider.get(provider);
  }

  async resolveEmail(provider: string, email: string): Promise<string | null | undefined> {
    const directory = this.byProvider.get(provider);

    return directory ? directory.resolveEmail(email) : undefined;
  }

  async subjectExists(provider: string, subject: string): Promise<boolean> {
    const directory = this.byProvider.get(provider);

    return directory ? directory.subjectExists(subject) : true;
  }

  async groupSize(provider: string, groupId: string): Promise<number | null> {
    const directory = this.byProvider.get(provider);
    return directory ? directory.groupSize(groupId) : null;
  }
}

/**
 * Deterministic hash of all directory configs
 *
 * used to detect config changes
 */
function fingerprintOf(config: ConfigService): string {
  const parts: unknown[] = [];
  for (const id of config.providerShortIds) {
    const directory = directoryOf(config, id);
    if (!directory) continue;
    parts.push([
      id,
      directory.type,
      directory.tenant_id ?? '',
      directory.client_id ?? '',
      directory.client_secret ?? '',
      directory.app_id ?? '',
      directory.private_key ?? '',
      directory.cache_ttl ?? '',
      directory.type === 'github'
        ? ((config.provider(id) as GithubProviderConfig).base_url ?? '')
        : '',
      config.groupSourcesByProvider(id).join(','),
    ]);
  }
  return JSON.stringify(parts);
}

function directoryOf(config: ConfigService, id: string): DirectoryConfig | undefined {
  const provider = config.provider(id);
  return provider && 'directory' in provider ? provider.directory : undefined;
}

let memo: { fingerprint: string; lookup: DirectoryLookup | undefined } | null = null;

/**
 * Directory lookup constructor with memoisation
 *
 * Skips memo on probe (deps supplied) so cached state is not reused
 */
export interface DirectoryDeps extends GraphDirectoryDeps {
  /** Overrides for a GitHub directory; the fields beside this one are Graph's */
  github?: GithubDirectoryDeps;
}

export function createDirectoryLookup(
  config: ConfigService,
  deps?: DirectoryDeps,
): DirectoryLookup | undefined {
  if (deps) return build(config, deps);

  const fingerprint = fingerprintOf(config);
  if (memo?.fingerprint === fingerprint) return memo.lookup;

  const lookup = build(config, undefined);
  memo = { fingerprint, lookup };
  return lookup;
}

function build(
  config: ConfigService,
  deps: DirectoryDeps | undefined,
): DirectoryLookup | undefined {
  const byProvider = new Map<string, Directory>();

  for (const shortId of config.providerShortIds) {
    const directory = directoryOf(config, shortId);
    if (!directory) continue;

    if (directory.type === 'graph') {
      byProvider.set(
        shortId,
        new GraphDirectory(shortId, directory, config.groupSourcesByProvider(shortId), deps),
      );
      continue;
    }
    if (directory.type === 'github') {
      byProvider.set(
        shortId,
        new GithubDirectory(
          shortId,
          directory,
          config,
          config.groupSourcesByProvider(shortId),
          deps?.github,
        ),
      );
      continue;
    }

    log.warn('directory type is configured but not implemented', {
      provider: shortId,
      type: directory.type,
    });
  }

  if (byProvider.size === 0) return undefined;
  log.info('directory lookup enabled', { providers: [...byProvider.keys()].join(',') });
  return new Directories(byProvider);
}

export async function refreshGroupIds(
  config: ConfigService,
  providerId: string,
  subject: string,
  fetchedAt: Date | null,
  now: number = Date.now(),
  deps?: DirectoryDeps,
): Promise<string[] | null> {
  const directory = directoryOf(config, providerId);
  if (!directory) return null;

  const ttl = parseDurationWithFallback(directory.cache_ttl, '1h');
  if (now - (fetchedAt?.getTime() ?? 0) < ttl) return null;

  const lookup = createDirectoryLookup(config, deps);
  const client = lookup instanceof Directories ? lookup.clientFor(providerId) : undefined;
  return client?.groupsFor ? client.groupsFor(subject, { fresh: fetchedAt === null }) : null;
}

/**
 * Checks if sub still exists in the directory and returns its groups
 *
 * 'gone' -> deleted, disabled, or no longer in the organisation
 * null -> no directory that can read groups, or it could not answer
 */
export async function recheckSubject(
  config: ConfigService,
  providerId: string,
  subject: string,
  deps?: DirectoryDeps,
): Promise<{ groups: string[] } | 'gone' | null> {
  const lookup = createDirectoryLookup(config, deps);
  const client = lookup instanceof Directories ? lookup.clientFor(providerId) : undefined;
  if (!client?.groupsFor) return null;

  try {
    if (!(await client.subjectExists(subject))) return 'gone';
  } catch (err) {
    if (err instanceof DirectoryUnavailableError) return null;
    throw err;
  }

  const groups = await client.groupsFor(subject, { fresh: true });
  return groups === null ? null : { groups };
}

export const DIRECTORY_DEPS = Symbol('DIRECTORY_DEPS');

/**
 * Whether this provider has a directory a probe could reach.
 *
 * Exported because the page that offers the check has to decide whether to offer it
 * *without* making it — an absent check is not a failed one, and the alternative is
 * asking the probe, which is the request being deferred. One predicate, so the offer
 * and the answer cannot come to disagree about which providers have one.
 */
export function hasDirectory(config: ConfigService, providerId: string): boolean {
  return directoryOf(config, providerId) !== undefined;
}

/** Probe a single provider's directory connectivity, null when it has none */
export async function probeDirectory(
  config: ConfigService,
  providerId: string,
  deps?: DirectoryDeps,
): Promise<DirectoryStatus | null> {
  if (!hasDirectory(config, providerId)) return null;

  const lookup = createDirectoryLookup(config, deps);
  const client = lookup instanceof Directories ? lookup.clientFor(providerId) : undefined;
  return client ? client.probe() : null;
}

/**
 * Resolved size and portal URL for a group
 *
 * name matches the grant; size is the member count, null on missing group;
 * directoryUrl is the Azure portal link, empty when issuer is not Entra
 */
export interface GroupReach {
  name: string;
  size: number | null;
  directoryUrl: string;
}

/**
 * Resolve size and portal URL for a list of groups
 */
export async function groupReach(
  config: ConfigService,
  directory: DirectoryLookup | undefined,
  names: string[],
  now: Date = new Date(),
): Promise<GroupReach[]> {
  const out: GroupReach[] = [];

  for (const name of names) {
    const sources = config.groupSources(name, now);
    let size: number | null = null;
    let url = '';

    const individuals = sources.filter(
      (s) => s.subject !== undefined || s.email !== undefined,
    ).length;
    if (individuals > 0) size = individuals;

    for (const source of sources) {
      if (source.id === undefined) continue;
      url ||= entraGroupUrl(config, source.provider, source.id);
      const mapped = directory ? await directory.groupSize(source.provider, source.id) : null;

      if (mapped === null) {
        size = null;
        break;
      }
      size = (size ?? 0) + mapped;
    }

    out.push({ name, size, directoryUrl: url });
  }

  return out;
}

/** Azure portal URL for a group, empty when issuer is not Entra v2.0 */
export function entraGroupUrl(config: ConfigService, providerId: string, groupId: string): string {
  const provider = config.provider(providerId);
  const issuer = provider && 'issuer' in provider ? (provider.issuer ?? '') : '';
  // Matches Microsoft Entra v2.0 issuer URLs
  if (!/^https:\/\/login\.microsoftonline\.com\/[^/\s]+\/v2\.0$/.test(issuer)) return '';
  return entraPortalGroupUrl(groupId);
}
