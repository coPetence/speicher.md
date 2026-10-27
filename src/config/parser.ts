import { readFileSync } from 'node:fs';

import { ConfigProblem, problem } from '../common/config-problems';
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
import { ajvProblems, validateInstanceSchema } from './schemas';
import { ConfigSource, InstanceConfig, SkippedConfigVersion } from './types';

/** Parsed, interpolated and validated instance config */
export interface LoadedInstanceConfig {
  raw: InstanceConfig;
  brandImages: BrandImages;
  brandProblems: ConfigProblem[];
  /** File or database */
  source: ConfigSource;
  /** Absolute file path; null for database configs */
  sourcePath: string | null;
  /** Database version; null for file configs */
  version: number | null;
  /** Unloadable newer versions, newest first */
  skipped: SkippedConfigVersion[];
  /** Primary forge ID; null if no forge is configured */
  primaryForgeId: string | null;
  /** Hash of settings that control page access */
  resolutionHash: string;
}

/** Load and validate a YAML config file */
export function loadInstanceConfigFromFile(path: string): LoadedInstanceConfig {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(
      problem('config.unreadable', null, {
        text: `Cannot read config file ${path}: ${(err as Error).message}`,
      }),
    );
  }
  return { ...loadInstanceConfig(source), source: 'file', sourcePath: path };
}

/**
 * Parse YAML, expand env vars, remove retired keys and validate
 * Throws ConfigError on failure
 */
export function loadInstanceConfig(yaml: string): LoadedInstanceConfig {
  let parsed;
  try {
    parsed = parseStrictYaml<InstanceConfig>(yaml);
  } catch (err) {
    throw new ConfigError(
      problem('config.yaml-invalid', null, {
        text: `Invalid config YAML: ${(err as Error).message}`,
      }),
    );
  }
  const config = interpolateEnv(parsed.value);
  dropRetiredKeys(config);

  if (!validateInstanceSchema(config)) {
    throw new ConfigError(
      problem('config.schema', null, {
        text: 'Config has missing or invalid settings.',
        dashboard: 'Fix the errors below before saving.',
      }),
      ajvProblems(validateInstanceSchema.errors),
    );
  }

  const problems: ConfigProblem[] = [];
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
    throw new ConfigError(
      problem('config.inconsistent', null, {
        text: 'Config settings fail validation.',
        dashboard: 'Fix the errors below before saving.',
      }),
      problems,
    );
  }

  const brand = resolveBrandImages(config);

  // Caller sets source, sourcePath and version
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
