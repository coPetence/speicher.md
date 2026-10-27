/** Load config from file or database, falling back to valid versions */

import { readFileSync } from 'node:fs';

import { QueryTypes } from 'sequelize';

import { ConfigProblem, problem, wordingFor } from '../common/config-problems';
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

/** Environment variable for the config file path */
export const INSTANCE_CONFIG_PATH_ENV = 'SPEICHER_CONFIG' satisfies EnvName;
/** Environment variable selecting file or database config */
export const CONFIG_SOURCE_ENV = 'SPEICHER_CONFIG_SOURCE' satisfies EnvName;

export function resolveConfigPath(): string {
  return env(INSTANCE_CONFIG_PATH_ENV);
}

export function resolveConfigSource(): ConfigSource {
  return env(CONFIG_SOURCE_ENV);
}

/** Who initiated the save */
export type SaveActor = { origin: 'admin'; appliedBy: string | null } | { origin: 'setup' };

/** Stored config version */
export interface ConfigVersion {
  version: number;
  yaml: string;
  resolution_hash: string;
  origin: 'file' | 'admin' | 'setup';
  applied_by: string | null;
  applied_at: Date;
}

export interface StoredConfigText {
  /** Original YAML */
  yaml: string;
  /** Null for file config or no saved version */
  version: number | null;
  source: ConfigSource;
}

/** Read tenant config without interpolation or validation */
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

/** Load file or latest valid DB config; seed or show setup if empty */
export async function loadActiveInstanceConfig(): Promise<LoadedInstanceConfig> {
  if (resolveConfigSource() === 'file') {
    const loaded = loadInstanceConfigFromFile(resolveConfigPath());
    announceUnadministrable(loaded);

    if (!instanceConfigHasBrandImageRefs(loaded.raw)) return announceBrandProblems(loaded);

    return announceBrandProblems({ ...loaded, ...(await loadBrandImages(loaded)) });
  }

  const tenant = await tenancy.defaultTenant();
  const newest = (await getNewestConfigVersion(tenant.id)) ?? (await seedFromFile(tenant.id));
  if (!newest) {
    rootLogger.child('config').warn('No configuration found. Showing the setup claim page.', {
      source: 'database',
    });
    return unclaimedInstanceConfig();
  }

  const skipped: SkippedConfigVersion[] = [];
  let candidate: ConfigVersion | null = newest;

  while (candidate) {
    try {
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
      // Only config errors trigger fallback
      if (!(err instanceof ConfigError)) throw err;
      const issues = err.issues.length > 0 ? err.issues : [err.summary];
      skipped.push({
        version: candidate.version,
        problems: issues.map((p) => wordingFor(p, 'yaml')),
        issues,
      });
      candidate = await configVersionBelow(tenant.id, candidate.version);
    }
  }

  throw new ConfigError(
    problem('config.no-version-loads', null, {
      text:
        `No saved configuration could be loaded. Tried ${skipped.length} versions: ` +
        `${skipped.map((s) => `v${s.version}`).join(', ')}.`,
    }),
    // Add version labels without changing problem codes
    skipped.flatMap((s) =>
      s.issues.map((p) => ({ ...p, path: null, text: `v${s.version}: ${wordingFor(p, 'yaml')}` })),
    ),
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
        problem('brand.image-not-stored', null, {
          text: `Cannot read stored brand images: ${reasonOf(err)}`,
        }),
      ],
    };
  }
}

/** Warn about unavailable brand images */
function announceBrandProblems(loaded: LoadedInstanceConfig): LoadedInstanceConfig {
  if (loaded.brandProblems.length > 0) {
    rootLogger.child('config').warn('Configured brand images are unavailable.', {
      problems: loaded.brandProblems.map((p) => wordingFor(p, 'yaml')),
      codes: loaded.brandProblems.map((p) => p.code),
    });
  }
  return loaded;
}

// Avoid duplicate fallback logs during polling
let announcedFallback = '';

/** Log fallback to an older version */
function announceFallback(version: number, skipped: SkippedConfigVersion[]): void {
  const lines = skipped.map((s) => `v${s.version}: ${s.problems.join('; ')}`);
  const key = JSON.stringify([version, lines]);
  if (key === announcedFallback) return;
  announcedFallback = key;
  rootLogger.child('config').error('Using an older configuration. Newer versions failed to load.', {
    running: version,
    skipped: lines,
  });
}

/** Report admin lockout */
function announceUnadministrable(loaded: LoadedInstanceConfig): void {
  const lockout = adminLockout(loaded.raw);
  if (!lockout) return;
  rootLogger.child('config').error('No administrator configured.', {
    code: lockout.code,
    reason: wordingFor(lockout, 'yaml'),
    config: loaded.sourcePath,
  });
}

/** Fetch the tenant's next older config */
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

/** Fetch the tenant's newest config */
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

/** List tenant configs newest first, up to the limit */
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

/** Fetch a specific tenant config version */
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

/** Validate and save; reject file mode and version conflicts */
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
    // Concurrent save won; require reload and retry
    throw new ConfigError(
      problem('config.version-conflict', null, {
        text: 'A newer configuration was saved. Reload it and reapply your changes.',
        dashboard: 'A newer configuration was saved. Reload the page and reapply your changes.',
      }),
    );
  }
  return saved;
}

/** Check schema, admins, keys, and SSH trust; allow skipping admins */
export function validateForSave(
  yaml: string,
  options: { requireAdministrator?: boolean } = {},
): LoadedInstanceConfig {
  const loaded = loadInstanceConfig(yaml);
  const lockout = options.requireAdministrator === false ? null : adminLockout(loaded.raw);
  if (lockout) throw new ConfigError(lockout);
  const keys = unreadablePrivateKeys(loaded.raw);
  if (keys.length > 0) {
    throw new ConfigError(
      problem('config.private-key-unreadable', null, {
        text: 'Cannot read a GitHub App private key.',
        dashboard: 'Cannot read a GitHub App private key.',
      }),
      keys,
    );
  }

  const hosts = serversWithoutTrustedKey(loaded.raw);
  if (hosts.length > 0) {
    throw new ConfigError(
      problem('config.host-key-missing', null, {
        text: 'An SSH server is missing a trusted host key.',
        dashboard: 'An SSH server is missing a trusted host key.',
      }),
      hosts,
    );
  }
  return loaded;
}

/** Find SSH repository servers missing trusted host keys */
function serversWithoutTrustedKey(config: InstanceConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  for (const [key, forge] of Object.entries(config.forges ?? {})) {
    if (forge.type !== 'git') continue;
    for (const name of serversWithoutHostKey(forge)) {
      problems.push(
        problem('forges.host-key-missing', `forges.${key}.known_hosts`, {
          text: `Cannot fetch from ${name}: no trusted host key. Verify its key and add it to \`known_hosts\`.`,
          dashboard: `Cannot fetch from ${name}: no trusted host key. Click Fetch host keys, verify the fingerprints against the server's published fingerprints, then save.`,
        }),
      );
    }
  }
  return problems;
}

/** Find unreadable GitHub private keys */
function unreadablePrivateKeys(config: InstanceConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  for (const [key, forge] of Object.entries(config.forges ?? {})) {
    if (forge.type !== 'github' || forge.private_key === undefined) continue;
    const unreadable = privateKeyProblem(forge.private_key);
    if (unreadable) {
      problems.push(
        problem('github.private-key-unreadable', `forges.${key}.private_key`, {
          text: unreadable,
          dashboard: 'Cannot read this private key. Upload the .pem file again.',
        }),
      );
    }
  }
  for (const [key, provider] of Object.entries(config.auth?.providers ?? {})) {
    const directory = 'directory' in provider ? provider.directory : undefined;
    if (directory?.type !== 'github' || directory.private_key === undefined) continue;

    const unreadable = privateKeyProblem(directory.private_key);
    if (unreadable) {
      problems.push(
        problem('github.private-key-unreadable', `auth.providers.${key}.directory.private_key`, {
          text: unreadable,
          dashboard: 'Cannot read this private key. Upload the .pem file again.',
        }),
      );
    }
  }
  return problems;
}

/** Insert the next version; return null on version conflict */
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

/** Seed from file; return null if unreadable */
async function seedFromFile(tenantId: string): Promise<ConfigVersion | null> {
  const path = resolveConfigPath();
  let yaml: string;
  try {
    yaml = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  const loaded = loadInstanceConfig(yaml);

  const seeded = await appendConfigVersion(tenantId, {
    yaml,
    resolutionHash: loaded.resolutionHash,
    origin: 'file',
    appliedBy: null,
  });
  // Use the existing version if another writer seeded first
  if (!seeded) return getNewestConfigVersion(tenantId);

  rootLogger.child('config').info('Imported the configuration file as version 1.', { path });
  return seeded;
}
