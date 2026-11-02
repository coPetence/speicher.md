/**
 * Admin dashboard data access
 *
 * All queries use raw SQL via Sequelize, returning typed row interfaces
 * Used by the admin controller and the status service
 */

import { QueryTypes } from 'sequelize';

import { getSequelize } from '../db/sequelize';

export class DashboardRepository {
  /** Repo status overview rows for a tenant
   *
   * Each row includes the repo's latest sync metadata
   * scope is 'all' (admin) or the subset of repo IDs the caller can operate */
  async repoStatusRows(tenantId: string, scope: 'all' | string[]): Promise<StatusRow[]> {
    return getSequelize().query<StatusRow>(
      `SELECT r.id, r.namespace, r.slug, r.last_sha, r.last_run_at, r.last_status,
              r.last_error, r.last_error_public, r.poll_interval_ms, r.has_config,
              f.key AS forge_key, f.type AS forge_type
         FROM repos r
         LEFT JOIN forges f ON f.id = r.forge_id
        WHERE r.tenant_id = :tenantId
          AND (:all::boolean OR r.id = ANY (CAST(:ids AS uuid[])))
        ORDER BY r.namespace, r.slug`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId,
          all: scope === 'all',
          ids: scope === 'all' ? '{}' : `{${scope.join(',')}}`,
        },
      },
    );
  }

  /** Look up a repo by namespace and slug, returning its ID */
  async findRepo(
    tenantId: string,
    namespace: string,
    slug: string,
  ): Promise<{ id: string } | null> {
    const rows = await getSequelize().query<{ id: string }>(
      `SELECT id FROM repos
        WHERE tenant_id = :tenantId AND namespace = :namespace AND slug = :slug`,
      { type: QueryTypes.SELECT, replacements: { tenantId, namespace, slug } },
    );
    return rows[0] ?? null;
  }

  async repoIdsOf(tenantId: string, forgeKeys: string[]): Promise<string[]> {
    if (forgeKeys.length === 0) return [];
    const rows = await getSequelize().query<{ id: string }>(
      `SELECT r.id
         FROM repos r JOIN forges f ON f.id = r.forge_id
        WHERE r.tenant_id = :tenantId AND f.key IN (:forgeKeys)`,
      { type: QueryTypes.SELECT, replacements: { tenantId, forgeKeys } },
    );
    return rows.map((row) => row.id);
  }

  /** The kind of source a repo came from, for the mark drawn beside its name */
  async forgeTypeOf(repoId: string): Promise<string | null> {
    const rows = await getSequelize().query<{ forge_type: string | null }>(
      `SELECT f.type AS forge_type
         FROM repos r LEFT JOIN forges f ON f.id = r.forge_id
        WHERE r.id = :repoId`,
      { type: QueryTypes.SELECT, replacements: { repoId } },
    );
    return rows[0]?.forge_type ?? null;
  }

  /**
   * Whether a content sync of this repo is running or about to
   *
   * Read off the queue rather than off `sync_runs`, because a run row exists only
   * once the worker has started — the gap between pressing Sync now and the claim
   * is exactly when the button must already say so. Every producer (webhook,
   * reconciler, CLI, this page) keys the job `sync-repo-content:<repo id>`.
   *
   * A pending job counts only while it is due. One waiting out a retry backoff
   * (up to half an hour) is not a sync in progress, and pressing Sync now is then
   * useful: `enqueue` keeps the earlier run time, so it brings the retry forward.
   * The ten seconds cover the webhook's own debounce. */
  async syncInFlight(tenantId: string, repoId: string): Promise<boolean> {
    const rows = await getSequelize().query<{ in_flight: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM jobs
          WHERE tenant_id = :tenantId
            AND kind = 'sync-repo-content'
            AND dedupe_key = :dedupeKey
            AND (status = 'running'
                 OR (status = 'pending' AND run_after <= now() + interval '10 seconds'))
       ) AS in_flight`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, dedupeKey: `sync-repo-content:${repoId}` },
      },
    );
    return rows[0]?.in_flight ?? false;
  }

  /** Configuration columns for a single repo */
  async repoConfigRow(repoId: string): Promise<RepoConfigRow | null> {
    const rows = await getSequelize().query<RepoConfigRow>(
      `SELECT display_title, cover_path, maintainer_principals,
              has_config, poll_interval_ms
         FROM repos WHERE id = :repoId`,
      { type: QueryTypes.SELECT, replacements: { repoId } },
    );
    return rows[0] ?? null;
  }

  /** Last 20 sync runs for a repo
   *
   * Findings are excluded when withFindings is false
   * Not withFindings to avoid leaking internal diagnostics to non-admins */
  async recentRuns(repoId: string, withFindings: boolean): Promise<RunRow[]> {
    return getSequelize().query<RunRow>(
      `SELECT id, sha, trigger, started_at, finished_at, status, stats,
              CASE WHEN :withFindings::boolean THEN findings ELSE '[]'::jsonb END AS findings
         FROM sync_runs WHERE repo_id = :repoId
        ORDER BY started_at DESC LIMIT 20`,
      { type: QueryTypes.SELECT, replacements: { repoId, withFindings } },
    );
  }

  /** One sync run, only when it belongs to the given repo
   *
   * The repo is in the predicate, not checked afterwards: a run id from a
   * repository the caller cannot operate is not found, exactly as an id that
   * does not exist. Findings withheld on the same terms as `recentRuns` */
  async runOf(repoId: string, runId: string, withFindings: boolean): Promise<RunRow | null> {
    const rows = await getSequelize().query<RunRow>(
      `SELECT id, sha, trigger, started_at, finished_at, status, stats,
              CASE WHEN :withFindings::boolean THEN findings ELSE '[]'::jsonb END AS findings
         FROM sync_runs WHERE id = CAST(:runId AS uuid) AND repo_id = :repoId`,
      { type: QueryTypes.SELECT, replacements: { repoId, runId, withFindings } },
    );
    return rows[0] ?? null;
  }

  /** Count of dead jobs scoped to a tenant */
  async deadJobCount(tenantId: string): Promise<number> {
    const [row] = await getSequelize().query<{ count: string }>(
      `SELECT count(*) AS count FROM jobs WHERE tenant_id = :tenantId AND status = 'dead'`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
    return Number(row.count);
  }

  /**
   * Jobs running now, and jobs due to run, which wait only for a free worker slot
   */
  async jobActivity(tenantId: string): Promise<JobActivityRow[]> {
    return getSequelize().query<JobActivityRow>(
      `SELECT kind, payload->>'repoId' AS repo_id, payload->>'forgeKey' AS forge_key,
              CASE WHEN status = 'running' AND locked_until >= now() THEN 'running'
                   ELSE 'queued' END AS activity
         FROM jobs
        WHERE tenant_id = :tenantId
          AND (status = 'running' OR (status = 'pending' AND run_after <= now()))`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
  }

  /** One page of dead jobs with repo context and forge key, newest first */
  async deadJobs(tenantId: string, page: { limit: number; offset: number }): Promise<DeadJobRow[]> {
    return getSequelize().query<DeadJobRow>(
      `SELECT j.id, j.kind, j.payload, j.attempts, j.last_error, j.updated_at,
              r.namespace AS repo_namespace, r.slug AS repo_slug,
              COALESCE(f.key, j.payload->>'forgeKey') AS forge_key
         FROM jobs j
         LEFT JOIN repos r
                ON r.tenant_id = j.tenant_id AND r.id::text = j.payload->>'repoId'
         LEFT JOIN forges f ON f.id = r.forge_id
        WHERE j.tenant_id = :tenantId AND j.status = 'dead'
        ORDER BY j.updated_at DESC, j.id
        LIMIT :limit OFFSET :offset`,
      { type: QueryTypes.SELECT, replacements: { tenantId, ...page } },
    );
  }
}

/** Row shape for the repo status overview */
export interface JobActivityRow {
  kind: string;
  /** Set on a job about one repository, such as `sync-repo-content` */
  repo_id: string | null;
  /** Set on a job about one content source, such as `sync-repo-list` */
  forge_key: string | null;
  activity: 'running' | 'queued';
}

export interface StatusRow {
  id: string;
  namespace: string;
  slug: string;
  last_sha: string | null;
  last_run_at: Date | null;
  last_status: string;
  last_error: string | null;
  last_error_public: string | null;
  poll_interval_ms: number | null;
  has_config: boolean;
  /** The content source the repository came from, and its kind
   *
   * A LEFT JOIN: the forge row is written by discovery, and a repository whose
   * forge row has not been written yet is still a repository to report on */
  forge_key: string | null;
  forge_type: string | null;
}

/** Row shape for a sync run with optional findings */
export interface RunRow {
  id: string;
  sha: string | null;
  trigger: string;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  stats: {
    documents?: number;
    assets?: number;
    dropped_grants?: number;
    failed_subtrees?: string[];
  } | null;
  findings:
    | {
        severity: string;
        code: string;
        source: string;
        line?: number;
        message: string;
        adminMessage?: string;
      }[]
    | null;
}

/** Row shape for a dead job with resolved repo and forge context */
export interface DeadJobRow {
  id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  last_error: string | null;
  updated_at: Date;

  repo_namespace: string | null;
  repo_slug: string | null;

  forge_key: string | null;
}

/** Row shape for a repo's configuration columns */
export interface RepoConfigRow {
  display_title: string | null;
  cover_path: string | null;
  maintainer_principals: string[];
  has_config: boolean;
  poll_interval_ms: number | null;
}
