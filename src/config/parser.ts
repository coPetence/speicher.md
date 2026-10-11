import { readFileSync } from 'node:fs';

import { ConfigError } from '../common/errors';
import { parseStrictYaml } from '../common/yaml';
import type { BrandImages } from './brand-resolve';
import { resolveBrandImages } from './brand-resolve';
import { checkAdmins } from './checks/admins';
import { checkFirstSegments, resolvePrimaryForge } from './checks/forges';
import {
  checkAnalytics,
  checkBrandLogo,
  checkCaseCollisions,
  checkReservedPublicName,
} from './checks/general';
import { checkGitForges } from './checks/git-forges';
import { checkGroups } from './checks/groups';
import { checkProviders } from './checks/providers';
import { interpolateEnv } from './env-interpolation';
import { dropRetiredKeys } from './retired-keys';
import { computeResolutionHash } from './resolution-hash';
import { formatAjvErrors, validateInstanceSchema } from './schemas';
import { ConfigSource, InstanceConfig, SkippedConfigVersion } from './types';

/** The instance config after it has been parsed, interpolated and checked */
export interface LoadedInstanceConfig {
  raw: InstanceConfig;
  brandImages: BrandImages;
  brandProblems: string[];
  /** Whether the config was loaded from a file or from the database */
  source: ConfigSource;
  /** The absolute path the config was read from. Null in `database` mode. */
  sourcePath: string | null;
  /** The `instance_configs` version the config came from. Null in `file` mode. */
  version: number | null;
  /** Newer versions that could not be loaded, newest first */
  skipped: SkippedConfigVersion[];
  /** The id of the primary forge. Null when no forge is configured. */
  primaryForgeId: string | null;
  /** The hash of the config keys that decide who may read which page */
  resolutionHash: string;
}

/**
 * loadInstanceConfigFromFile reads the instance config from a file and loads it.
 *
 * @param path the path of the YAML file
 */
export function loadInstanceConfigFromFile(path: string): LoadedInstanceConfig {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read instance config at ${path}: ${(err as Error).message}`);
  }
  return { ...loadInstanceConfig(source), source: 'file', sourcePath: path };
}

/**
 * loadInstanceConfig parses YAML, fills in `${VAR}` references, drops keys the schema
 * has retired, validates the result against the schema and runs every check the schema
 * cannot express. Throws a `ConfigError` if any of these steps fail.
 *
 * @param yaml the instance config as YAML text
 */
export function loadInstanceConfig(yaml: string): LoadedInstanceConfig {
  let parsed;
  try {
    parsed = parseStrictYaml<InstanceConfig>(yaml);
  } catch (err) {
    throw new ConfigError(`instance config is not valid YAML: ${(err as Error).message}`);
  }
  const config = interpolateEnv(parsed.value);
  dropRetiredKeys(config);

  if (!validateInstanceSchema(config)) {
    throw new ConfigError(
      'instance config failed schema validation',
      formatAjvErrors(validateInstanceSchema.errors),
    );
  }

  const problems: string[] = [];
  const primaryForgeId = resolvePrimaryForge(config.forges ?? {}, problems);

  checkBrandLogo(config, problems);
  checkProviders(config, problems);
  checkGroups(config, problems);
  checkAnalytics(config, problems);
  checkAdmins(config, problems);
  checkReservedPublicName(config, problems);
  checkCaseCollisions(config, problems);
  checkGitForges(config, problems);
  checkFirstSegments(config, primaryForgeId, problems);

  if (problems.length > 0) {
    throw new ConfigError('instance config is not internally consistent', problems);
  }

  const brand = resolveBrandImages(config);

  // The caller overwrites source, sourcePath and version, since only it knows where
  // the YAML came from
  return {
    raw: config,
    brandImages: brand.images,
    brandProblems: brand.problems,
    source: 'file',
    sourcePath: null,
    version: null,
    skipped: [],
    primaryForgeId,
    resolutionHash: computeResolutionHash(config, primaryForgeId),
  };
}
