import { createHash } from 'node:crypto';

import { InstanceConfig, SYNC_DEFAULTS, autolinkExcludedDomains, providerType } from './types';

/**
 * computeResolutionHash hashes the part of the config that decides who may read
 * which page. When the hash changes, every materialised row has to be rebuilt.
 *
 * @param config the loaded instance config
 * @param primaryForgeId the id of the primary forge, or null if there is no forge
 */
export function computeResolutionHash(
  config: InstanceConfig,
  primaryForgeId: string | null,
): string {
  const providers: Record<string, unknown> = {};
  for (const [id, provider] of Object.entries(config.auth?.providers ?? {})) {
    const type = providerType(provider);
    providers[id] = {
      type,
      subject_claim:
        type === 'oidc' ? ((provider as { subject_claim?: string }).subject_claim ?? 'sub') : null,
      groups_claim:
        type === 'oidc' ? ((provider as { groups_claim?: string }).groups_claim ?? 'groups') : null,
      email_claim:
        type === 'oidc' ? ((provider as { email_claim?: string }).email_claim ?? 'email') : null,
      // A directory decides whether email grants resolve to subjects at ingest
      directory:
        provider && 'directory' in provider && provider.directory ? provider.directory.type : null,
    };
  }

  const forges: Record<string, unknown> = {};
  for (const [id, forge] of Object.entries(config.forges ?? {})) {
    // `repos`, `poll_interval` and `known_hosts` are left out: they decide no principal,
    // and including them would rebuild every repository when one remote moves
    forges[id] = {
      type: forge.type,
      primary: id === primaryForgeId,
      default_repository_owner: forge.default_repository_owner ?? null,
    };
  }

  const excludedDomains = autolinkExcludedDomains(config);
  const subset = {
    default_provider: config.auth?.default_provider ?? null,
    providers,
    // Only the group names: membership is resolved per request, but defining or
    // removing a group changes which rows ingest accepts
    groups: Object.keys(config.groups ?? {}).sort(),
    public: config.public ?? null,
    forges,
    primary_forge: primaryForgeId,
    defaults: {
      sync: {
        include: config.defaults?.sync?.include ?? SYNC_DEFAULTS.include,
        exclude: config.defaults?.sync?.exclude ?? SYNC_DEFAULTS.exclude,
      },
      retrieval: { indexable: config.defaults?.retrieval?.indexable ?? true },
    },
    admins: config.admins,
    autolink: excludedDomains.length > 0 ? excludedDomains : undefined,
  };

  return createHash('sha256').update(stableStringify(subset)).digest('hex');
}

/**
 * stableStringify serialises a value to JSON with object keys sorted, so two
 * configs that differ only in key order produce the same string. Undefined
 * values are left out.
 *
 * @param value the value to serialise
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
