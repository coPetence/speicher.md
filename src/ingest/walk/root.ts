/**
 * Loading a repository's root configuration for ingest
 *
 * The first step of a repo walk: reads and validates the root .speicher.yaml
 * A missing root config raises NotPublishedError
 * Returns null on schema errors, access violations, or a missing ingest directory
 *
 * Folds the root config against instance defaults and resolves maintainers
 */

import { join, resolve } from 'node:path';

import { SpeicherConfig } from '../../config/types';
import { fold, instanceRoot } from '../cascade';
import { FindingList } from '../findings';
import { resolveAccessBlock } from '../grants';
import { CONFIG_FILENAME } from '../paths';
import { validateConfigFile } from '../validate';
import { isDirectory, isInside, readFileOrNull } from './fs';
import { GrantContext, RepoRoot } from './state';
import { WalkOptions } from './walk';

/** Repo has no root config and was never synced */
export class NotPublishedError extends Error {
  constructor() {
    super('repo has no root .speicher.yaml and is not synced');
    this.name = 'NotPublishedError';
  }
}

/** Read and validate the root config, returning a RepoRoot for scanning */
export async function loadRoot(
  options: WalkOptions,
  findings: FindingList,
): Promise<RepoRoot | null> {
  const { workingTree, config } = options;
  const now = options.now ?? new Date();

  const rootRaw = await readFileOrNull(join(workingTree, CONFIG_FILENAME));

  if (rootRaw === null) throw new NotPublishedError();

  const grantContext: GrantContext = {
    config,
    directory: options.directory,
    now,
    requireUntil: true,
    expiryWarningMs: options.expiryWarningMs ?? 14 * 86_400_000,
    publicGrant: config.allowsPublic(options.repo) ? 'enabled' : 'disabled',
  };

  const parsed = validateConfigFile(rootRaw, { source: CONFIG_FILENAME, isRoot: true }, findings);
  if (!parsed) return null;

  const rootConfig = parsed.config;
  const ingestRoot = normalizeIngestRoot(rootConfig.ingest_root ?? '');
  const ingestAbs = resolve(workingTree, ingestRoot);
  if (!isInside(workingTree, ingestAbs)) {
    findings.reject({
      code: 'schema-invalid',
      source: CONFIG_FILENAME,
      line: parsed.lineOf('ingest_root') ?? undefined,
      message: '`ingest_root` resolves outside the repository working tree',
    });
    return null;
  }

  const resolved = await fold(
    instanceRoot(config),
    rootConfig,
    { isRoot: true, source: CONFIG_FILENAME, baseDir: '', lineOf: parsed.lineOf, grantContext },
    findings,
  );

  const maintainerPrincipals = await resolveMaintainers(
    rootConfig,
    { ...grantContext, requireUntil: false },
    parsed.lineOf,
    findings,
  );

  if (findings.rejectionsUnder(CONFIG_FILENAME).length > 0) return null;

  if (!(await isDirectory(ingestAbs))) {
    findings.reject({
      code: 'schema-invalid',
      source: CONFIG_FILENAME,
      line: parsed.lineOf('ingest_root') ?? undefined,
      message: `\`ingest_root\` "${ingestRoot}" is not a directory in this repo`,
    });
    return null;
  }

  return {
    workingTree,
    config,
    ingestRoot,
    ingestAbs,
    rootConfig,
    lineOf: parsed.lineOf,
    resolved,
    maintainerPrincipals,
    grantContext,
    maxAssetBytes: options.maxAssetBytes ?? config.assets.max_asset_bytes ?? 10_485_760,
    findings,
  };
}

/**
 * Resolve the maintainers principal set
 *
 * Not requireUntil for maintainers: they are operational roles, not content access
 * Not publicGrant 'enabled' for maintainers: maintainers need a real credential
 */
async function resolveMaintainers(
  rootConfig: SpeicherConfig,
  grantContext: Parameters<typeof fold>[2]['grantContext'],
  lineOf: (key: string) => number | null,
  findings: FindingList,
): Promise<string[]> {
  if (!rootConfig.maintainers) return [];
  const resolved = await resolveAccessBlock(
    rootConfig.maintainers,
    {
      ...grantContext,
      source: CONFIG_FILENAME,
      // Maps access-block key paths to maintainers paths in parsed YAML
      lineOf: (k) => lineOf(k.replace(/^access/, 'maintainers')),
      requireUntil: false,
      publicGrant: 'refused',
    },
    findings,
  );
  return resolved.principals;
}

/** Normalize a path by removing empty segments and `.` */
function normalizeIngestRoot(value: string): string {
  return value
    .split('/')
    .filter((p) => p !== '' && p !== '.')
    .join('/');
}
