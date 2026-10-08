/**
 * Inspection queries for repos and forges
 *
 * Raw SQL queries that join across repos, forges, and installations
 * Used by the admin controller and CLI to display current state
 */

import { QueryTypes } from 'sequelize';

import { getSequelize } from '../db/sequelize';
import { slugify } from './slug';

/**
 * One repo with its forge key, latest run status, and installation info
 */
export interface RepoListRow {
  id: string;
  forge: string;
  namespace: string;
  slug: string;
  branch: string;
  has_config: boolean;
  last_status: string;
  last_sha: string | null;
  last_run_at: Date | null;
  installation: string | null;
}

/**
 * Lists all repositories for a tenant, with forge key and installation info
 */
export async function listRepos(tenantId: string): Promise<RepoListRow[]> {
  return getSequelize().query<RepoListRow>(
    `SELECT r.id, f.key AS forge, r.namespace, r.slug, r.branch, r.has_config,
            r.last_status, r.last_sha, r.last_run_at,
            i.forge_installation_id AS installation
       FROM repos r
       JOIN forges f ON f.id = r.forge_id
       LEFT JOIN installations i ON i.id = r.installation_id
      WHERE r.tenant_id = :tenantId
      ORDER BY r.namespace, r.slug`,
    { type: QueryTypes.SELECT, replacements: { tenantId } },
  );
}

/**
 * One forge with counts of its repos and installations
 */
export interface ForgeListRow {
  key: string;
  type: string;
  is_primary: boolean;
  default_repository_owner: string | null;
  repos: number;
  installations: number;
}

/**
 * Lists all forges for a tenant with repo and installation counts
 */
export async function listForges(tenantId: string): Promise<ForgeListRow[]> {
  return getSequelize().query<ForgeListRow>(
    `SELECT f.key, f.type, f.is_primary, f.default_repository_owner,
            (SELECT count(*)::int FROM repos r WHERE r.forge_id = f.id) AS repos,
            (SELECT count(*)::int FROM installations i WHERE i.forge_id = f.id) AS installations
       FROM forges f
      WHERE f.tenant_id = :tenantId
      ORDER BY f.key`,
    { type: QueryTypes.SELECT, replacements: { tenantId } },
  );
}

/**
 * Resolve a repository by namespace/slug or slug alone
 *
 * When asked has no `/`, matches across all namespaces in the tenant
 */
export async function resolveRepo(
  tenantId: string,
  asked: string,
): Promise<{ id: string; namespace: string; slug: string }[]> {
  const [namespace, slug] = asked.includes('/') ? asked.split('/', 2) : [null, asked];
  const rows = await getSequelize().query<{ id: string; namespace: string; slug: string }>(
    `SELECT id, namespace, slug FROM repos
      WHERE tenant_id = :tenantId AND slug = :slug
      ORDER BY namespace`,
    { type: QueryTypes.SELECT, replacements: { tenantId, slug } },
  );
  return rows.filter((row) => namespace === null || slugify(row.namespace) === slugify(namespace));
}
