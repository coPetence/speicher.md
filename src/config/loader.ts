/**
 * Reading, writing, and versioning instance configuration
 *
 * Config can be served from a file (read-only) or from the database (versioned)
 * In database mode, the newest valid version is used at boot, with fallback to
 * older versions on validation failure
 * The setup wizard receives the unclaimed placeholder when no config exists yet
 */

import { readFileSync } from 'node:fs';

import { QueryTypes } from 'sequelize';

import { EnvName, env } from '../common/env';
import { ConfigError, ConfigReadOnlyError, reasonOf } from '../common/errors';
import { rootLogger } from '../common/logger';
import { getSequelize } from '../db/sequelize';
import { tenancy } from '../db/tenancy';

import { unclaimedInstanceConfig } from '../dashboard/setup/unclaimed';
import { privateKeyProblem } from '../github/tokens';
import { instanceConfigHasBrandImageRefs, resolveBrandImagesForTenantId } from './brand-resolve';
import { serversWithoutHostKey } from '../forge/host-keys';
import { adminLockout } from './checks/admins';
import { LoadedInstanceConfig, loadInstanceConfig, loadInstanceConfigFromFile } from './parser';
import { ConfigSource, InstanceConfig, SkippedConfigVersion } from './types';

/** Environment variable holding the path to the instance config file */
export const INSTANCE_CONFIG_PATH_ENV = 'SPEICHER_CONFIG' satisfies EnvName;
/** Environment variable controlling whether config comes from a file or the database */
export const CONFIG_SOURCE_ENV = 'SPEICHER_CONFIG_SOURCE' satisfies EnvName;

/** Read the instance config file path from the environment */
export function resolveConfigPath(): string {
  return env(INSTANCE_CONFIG_PATH_ENV);
}

/** Read the config source mode from the environment */
export function resolveConfigSource(): ConfigSource {
  return env(CONFIG_SOURCE_ENV);
}

/** Who initiated a config save */
export type SaveActor = { origin: 'admin'; appliedBy: string | null } | { origin: 'setup' };

/** A row in the instance_configs table */
export interface ConfigVersion {
  version: number;
  yaml: string;
  resolution_hash: string;
  origin: 'file' | 'admin' | 'setup';
  applied_by: string | null;
  applied_at: Date;
}

export interface StoredConfigText {
  /** The document as stored, byte for byte */
  yaml: string;
  /** The version it was read from; null in `file` mode and on a fresh instance */
  version: number | null;
  source: ConfigSource;
}

/**
 * getConfigTextForTenant returns the instance configuration of the tenant with the given
 * tenantId. It is either read from the file or the newest database version. It neither interpolates `${VAR}` references nor validates the document.
 */
export async function getConfigTextForTenant(tenantId: string): Promise<StoredConfigText> {
  const source = resolveConfigSource();
  if (source === 'file') {
    return { yaml: readFileSync(resolveConfigPath(), 'utf8'), version: null, source };
  }
  const currentConfigVersion = await getNewestConfigVersion(tenantId);
  return {
    yaml: currentConfigVersion?.yaml ?? '',
    version: currentConfigVersion?.version ?? null,
    source,
  };
}

/**
 * Resolve and load the active instance configuration
 *
 * File mode returns the disk file; database mode walks back through valid versions,
 * seeding from file or returning the unclaimed placeholder when empty
 */
export async function loadActiveInstanceConfig(): Promise<LoadedInstanceConfig> {
  if (resolveConfigSource() === 'file') {
    const loaded = loadInstanceConfigFromFile(resolveConfigPath());
    announceUnadministrable(loaded);

    if (!instanceConfigHasBrandImageRefs(loaded.raw)) return announceBrandProblems(loaded);

    return announceBrandProblems({ ...loaded, ...(await loadBrandImages(loaded)) });
  }

  // tenant = instance; in most self hosted deployments the tenant is 'default'
  const tenant = await tenancy.defaultTenant();
  const newest = (await getNewestConfigVersion(tenant.id)) ?? (await seedFromFile(tenant.id));
  if (!newest) {
    // No stored or file config; serve the setup claim page
    rootLogger.child('config').warn('no instance configuration; serving the claim page', {
      source: 'database',
    });
    return unclaimedInstanceConfig();
  }

  const skipped: SkippedConfigVersion[] = [];
  let candidate: ConfigVersion | null = newest;

  while (candidate) {
    try {
      // Try to load this version; if it fails skip to the next below
      const parsed = loadInstanceConfig(candidate.yaml);
      const loaded = {
        ...parsed,
        ...(await loadBrandImages(parsed)),
        source: 'database' as ConfigSource,
        version: candidate.version,
        skipped,
      };
      if (skipped.length > 0) announceFallback(loaded.version as number, skipped);
      announceBrandProblems(loaded);
      return loaded;
    } catch (err) {
      // Only ConfigError means a bad version; rethrow unexpected errors
      if (!(err instanceof ConfigError)) throw err;
      skipped.push({
        version: candidate.version,
        problems: err.problems.length > 0 ? err.problems : [err.message],
      });
      candidate = await configVersionBelow(tenant.id, candidate.version);
    }
  }

  throw new ConfigError(
    `no stored instance config version loads (tried ${skipped.length}: ` +
      `${skipped.map((s) => `v${s.version}`).join(', ')})`,
    skipped.flatMap((s) => s.problems.map((p) => `v${s.version}: ${p}`)),
  );
}

async function loadBrandImages(
  parsed: LoadedInstanceConfig,
): Promise<Pick<LoadedInstanceConfig, 'brandImages' | 'brandProblems'>> {
  try {
    const tenant = await tenancy.defaultTenant();
    const resolved = await resolveBrandImagesForTenantId(tenant.id, parsed.raw);
    return { brandImages: resolved.images, brandProblems: resolved.problems };
  } catch (err) {
    return {
      brandImages: parsed.brandImages,
      brandProblems: [
        ...parsed.brandProblems,
        `the stored brand images could not be read: ${reasonOf(err)}`,
      ],
    };
  }
}

/** Log every brand image the active configuration names and does not have */
function announceBrandProblems(loaded: LoadedInstanceConfig): LoadedInstanceConfig {
  if (loaded.brandProblems.length > 0) {
    rootLogger.child('config').warn('a brand image this configuration names is not available', {
      problems: loaded.brandProblems,
    });
  }
  return loaded;
}

// The fallback last logged, so the watcher's poll does not repeat it every interval
let announcedFallback = '';

/** Log that an older config version was used because newer versions failed to load */
function announceFallback(version: number, skipped: SkippedConfigVersion[]): void {
  const lines = skipped.map((s) => `v${s.version}: ${s.problems.join('; ')}`);
  const key = JSON.stringify([version, lines]);
  if (key === announcedFallback) return;
  announcedFallback = key;
  rootLogger.child('config').error('booted on an older instance config version', {
    running: version,
    skipped: lines,
  });
}

/** Log that the active config has no admin group or user */
function announceUnadministrable(loaded: LoadedInstanceConfig): void {
  const lockout = adminLockout(loaded.raw);
  if (!lockout) return;
  rootLogger.child('config').error('this instance has no administrator', {
    reason: lockout,
    config: loaded.sourcePath,
  });
}

/** Fetch the next-lower config version from the database */
async function configVersionBelow(
  tenantId: string,
  version: number,
): Promise<ConfigVersion | null> {
  const rows = await getSequelize().query<ConfigVersion>(
    `SELECT version, yaml, resolution_hash, origin, applied_by, applied_at
       FROM instance_configs
      WHERE tenant_id = :tenantId AND version < :version
      ORDER BY version DESC
      LIMIT 1`,
    { type: QueryTypes.SELECT, replacements: { tenantId, version } },
  );
  return rows[0] ?? null;
}

/** Fetch the highest-numbered config version for the tenant */
export async function getNewestConfigVersion(tenantId: string): Promise<ConfigVersion | null> {
  const rows = await getSequelize().query<ConfigVersion>(
    `SELECT version, yaml, resolution_hash, origin, applied_by, applied_at
       FROM instance_configs
      WHERE tenant_id = :tenantId
      ORDER BY version DESC
      LIMIT 1`,
    { type: QueryTypes.SELECT, replacements: { tenantId } },
  );
  return rows[0] ?? null;
}

/** Fetch config versions, newest first, capped by limit */
export async function listConfigVersions(tenantId: string, limit = 100): Promise<ConfigVersion[]> {
  return getSequelize().query<ConfigVersion>(
    `SELECT version, yaml, resolution_hash, origin, applied_by, applied_at
       FROM instance_configs
      WHERE tenant_id = :tenantId
      ORDER BY version DESC
      LIMIT :limit`,
    { type: QueryTypes.SELECT, replacements: { tenantId, limit } },
  );
}

/** Fetch a specific config version by version number */
export async function configVersionAt(
  tenantId: string,
  version: number,
): Promise<ConfigVersion | null> {
  const rows = await getSequelize().query<ConfigVersion>(
    `SELECT version, yaml, resolution_hash, origin, applied_by, applied_at
       FROM instance_configs
      WHERE tenant_id = :tenantId AND version = :version`,
    { type: QueryTypes.SELECT, replacements: { tenantId, version } },
  );
  return rows[0] ?? null;
}

/**
 * Validate and persist a new config version
 *
 * Refuses to save in file mode
 * Atomically increments the version; returns null on collision so the caller retries
 */
export async function saveInstanceConfig(
  tenantId: string,
  yaml: string,
  by: SaveActor,
): Promise<ConfigVersion> {
  if (resolveConfigSource() === 'file') throw new ConfigReadOnlyError(resolveConfigPath());

  const loaded = validateForSave(yaml, {
    requireAdministrator: by.origin !== 'setup',
  });

  const saved = await appendConfigVersion(tenantId, {
    yaml,
    resolutionHash: loaded.resolutionHash,
    origin: by.origin,
    appliedBy: by.origin === 'setup' ? null : by.appliedBy,
  });
  if (!saved) {
    // Another writer inserted a row at the same version number; caller must retry
    throw new ConfigError(
      'a newer configuration version was saved while this one was being edited; ' +
        'reload the current version and re-apply the change',
    );
  }
  return saved;
}

/**
 * Parse and validate a YAML config before persisting
 *
 * Checks schema, admin presence, and private key readability
 * Setup origin may skip the admin check since no admin exists before claiming
 */
export function validateForSave(
  yaml: string,
  options: { requireAdministrator?: boolean } = {},
): LoadedInstanceConfig {
  const loaded = loadInstanceConfig(yaml);
  const lockout = options.requireAdministrator === false ? null : adminLockout(loaded.raw);
  if (lockout) {
    throw new ConfigError(
      'this configuration would leave nobody able to administer this instance',
      [lockout],
    );
  }
  const keys = unreadablePrivateKeys(loaded.raw);
  if (keys.length > 0) {
    throw new ConfigError('a GitHub App private key in this configuration cannot be read', keys);
  }

  // check that every `ssh://` repository has a known host key, so the instance can fetch it
  const hosts = serversWithoutTrustedKey(loaded.raw);
  if (hosts.length > 0) {
    throw new ConfigError('an SSH server in this configuration has no trusted host key', hosts);
  }
  return loaded;
}

/** Find the servers of `ssh://` repositories that `known_hosts` holds no key for */
function serversWithoutTrustedKey(config: InstanceConfig): string[] {
  const problems: string[] = [];
  for (const [key, forge] of Object.entries(config.forges ?? {})) {
    if (forge.type !== 'git') continue;
    for (const name of serversWithoutHostKey(forge)) {
      problems.push(
        `forge "${key}": Speicher has no host key for ${name}, so it cannot fetch the repositories on that server. To add the key, open the content source, press Fetch host keys, compare the fingerprints with the published ones, and save.`,
      );
    }
  }
  return problems;
}

/** Find GitHub private keys that cannot be parsed */
function unreadablePrivateKeys(config: InstanceConfig): string[] {
  const problems: string[] = [];
  for (const [key, forge] of Object.entries(config.forges ?? {})) {
    if (forge.type !== 'github' || forge.private_key === undefined) continue;
    const problem = privateKeyProblem(forge.private_key);
    if (problem) problems.push(`\`forges.${key}.private_key\`: ${problem}`);
  }
  for (const [key, provider] of Object.entries(config.auth?.providers ?? {})) {
    const directory = 'directory' in provider ? provider.directory : undefined;
    if (directory?.type !== 'github' || directory.private_key === undefined) continue;

    const problem = privateKeyProblem(directory.private_key);
    if (problem) {
      problems.push(`\`auth.providers.${key}.directory.private_key\`: ${problem}`);
    }
  }
  return problems;
}

/**
 * Insert a new config version at the next sequential number
 *
 * Uses ON CONFLICT DO NOTHING so concurrent inserts on the same version return null
 */
export async function appendConfigVersion(
  tenantId: string,
  input: {
    yaml: string;
    resolutionHash: string;
    origin: 'file' | 'admin' | 'setup';
    appliedBy: string | null;
  },
): Promise<ConfigVersion | null> {
  const rows = await getSequelize().query<ConfigVersion>(
    `INSERT INTO instance_configs (tenant_id, version, yaml, resolution_hash, origin, applied_by)
     SELECT :tenantId, COALESCE(max(version), 0) + 1, :yaml, :hash, :origin, :appliedBy
       FROM instance_configs WHERE tenant_id = :tenantId
     ON CONFLICT (tenant_id, version) DO NOTHING
     RETURNING version, yaml, resolution_hash, origin, applied_by, applied_at`,
    {
      type: QueryTypes.SELECT,
      replacements: {
        tenantId,
        yaml: input.yaml,
        hash: input.resolutionHash,
        origin: input.origin,
        appliedBy: input.appliedBy,
      },
    },
  );
  return rows[0] ?? null;
}

/**
 * Import the file config as version 1 when no database version exists
 *
 * Silently returns null when the file is unreadable so the caller serves the claim page
 */
async function seedFromFile(tenantId: string): Promise<ConfigVersion | null> {
  const path = resolveConfigPath();
  let yaml: string;
  try {
    yaml = readFileSync(path, 'utf8');
  } catch {
    // File missing or unreadable; caller will serve the claim page
    return null;
  }

  const loaded = loadInstanceConfig(yaml);

  const seeded = await appendConfigVersion(tenantId, {
    yaml,
    resolutionHash: loaded.resolutionHash,
    // origin 'file' records that this came from the initial import
    origin: 'file',
    appliedBy: null,
  });
  // Another writer seeded first; use their version
  if (!seeded) return getNewestConfigVersion(tenantId);

  rootLogger.child('config').info('adopted the config file as instance config version 1', { path });
  return seeded;
}
