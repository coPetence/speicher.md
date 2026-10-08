/**
 * Authz decision explanation for a path
 *
 * Queries documents, folders and assets for a given slug path and returns the
 * effective principals and the config chain that produced them
 *
 * Each row kind is selected separately because the three tables share the slug
 * path but differ in what columns they offer
 */
import { QueryTypes } from 'sequelize';

import { Principal, parsePrincipal } from '../common/principals';
import { getSequelize } from '../db/sequelize';

export interface CascadeLevel {
  /** Config file or inherited level in the chain */
  source: string;
  access?: { groups?: string[]; users?: unknown[] };
  resolved_principals: Principal[];
  indexable?: boolean;
  notes?: string[];
}

export interface ConfigSource {
  chain: CascadeLevel[];
  dropped_grants?: { principal: string; reason: string }[];
  findings?: { severity: string; message: string; source: string; line?: number }[];
}

export interface ExplainResult {
  found: boolean;
  kind: 'page' | 'folder' | 'asset' | null;
  slug_path: string;
  repo_id: string;
  effective_principals: Principal[];
  indexable: boolean | null;
  chain: CascadeLevel[];
  dropped_grants: { principal: string; reason: string }[];
  /** Group reachability info, populated only when includeGroupSizes is true */
  groups?: GroupReachRow[];
}

export interface GroupReachRow {
  name: string;
  size: number | null;
  /** URL to the group's directory entry in the identity provider */
  directory_url: string;
}

export async function explainPath(
  tenantId: string,
  repoId: string,
  slugPath: string,
  options: {
    includeGroupSizes: boolean;
    /** Async resolver that returns reachability for the named groups */
    reach?: (names: string[]) => Promise<GroupReachRow[]>;
  } = {
    includeGroupSizes: false,
  },
): Promise<ExplainResult> {
  const sequelize = getSequelize();

  const rows = await sequelize.query<{
    kind: 'page' | 'folder' | 'asset';
    slug_path: string;
    effective_principals: Principal[];
    indexable: boolean | null;
    config_source: ConfigSource;
  }>(
    `SELECT 'page'::text AS kind, slug_path, effective_principals, indexable, config_source
       FROM documents WHERE tenant_id = :tenantId AND repo_id = :repoId AND slug_path = :slugPath
     UNION ALL
     SELECT 'folder'::text, slug_path, effective_principals, NULL::boolean, config_source
       FROM folders WHERE tenant_id = :tenantId AND repo_id = :repoId AND slug_path = :slugPath
     UNION ALL
     SELECT 'asset'::text, slug_path, effective_principals, NULL::boolean, '{}'::jsonb
       FROM assets WHERE tenant_id = :tenantId AND repo_id = :repoId AND slug_path = :slugPath`,
    { type: QueryTypes.SELECT, replacements: { tenantId, repoId, slugPath } },
  );

  const row = rows[0];
  if (!row) {
    return {
      found: false,
      kind: null,
      slug_path: slugPath,
      repo_id: repoId,
      effective_principals: [],
      indexable: null,
      chain: [],
      dropped_grants: [],
    };
  }

  const source = row.config_source ?? { chain: [] };
  const result: ExplainResult = {
    found: true,
    kind: row.kind,
    slug_path: row.slug_path,
    repo_id: repoId,
    effective_principals: row.effective_principals,
    indexable: row.indexable,
    chain: source.chain ?? [],
    dropped_grants: source.dropped_grants ?? [],
  };

  if (options.includeGroupSizes) {
    const names: string[] = [];
    // de-duplicate group principals so reach is called once per group
    for (const principal of row.effective_principals) {
      const parsed = parsePrincipal(principal);
      if (parsed?.kind === 'group' && !names.includes(parsed.name)) names.push(parsed.name);
    }
    result.groups = options.reach
      ? await options.reach(names)
      : names.map((name) => ({ name, size: null, directory_url: '' }));
  }

  return result;
}

export async function explainRepoRoot(
  tenantId: string,
  repoId: string,
): Promise<RepoRootConfig | null> {
  const rows = await getSequelize().query<{
    effective_principals: Principal[];
    indexable: boolean | null;
    config_source: ConfigSource;
  }>(
    `SELECT effective_principals, NULL::boolean AS indexable, config_source
       FROM folders
      WHERE tenant_id = :tenantId AND repo_id = :repoId AND slug_path = ''`,
    { type: QueryTypes.SELECT, replacements: { tenantId, repoId } },
  );

  const row = rows[0];
  if (!row) return null;

  const chain = row.config_source?.chain ?? [];
  // Last level is the repo's own config, if present; otherwise the chain is
  // entirely inherited
  const own = chain.length > 1 ? chain[chain.length - 1] : undefined;
  return {
    granted: own?.access?.groups ?? [],
    hasOwnLevel: own !== undefined,
    principals: row.effective_principals,
    indexable: own?.indexable ?? chain[0]?.indexable ?? null,
  };
}

export interface RepoRootConfig {
  /** Groups granted access at the repo root level */
  granted: string[];
  /** True when the repo has its own authz config beyond the inherited default */
  hasOwnLevel: boolean;
  /** All effective principals including inherited ones */
  principals: Principal[];
  indexable: boolean | null;
}
