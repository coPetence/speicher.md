import { Injectable } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';

import { getSequelize } from '../../db/sequelize';
import { GraphEdgeRow, GraphPageRow, GraphReport } from './types';
import { EDGE_JOINS } from '../filter';

/**
 * Aggregate queries for the dashboard
 *
 * Used by StatusService and DashboardController to build operational views
 * for admins: embedding coverage per model, page counts per repo, and the
 * full link graph report
 *
 * Every method is scoped to a tenant
 */
@Injectable()
export class ContentReports {
  constructor(private readonly sequelize: Sequelize = getSequelize()) {}

  /**
   * Count chunks by embedding status for a given model and dimensions
   *
   * Current: embedded with the supplied model and dimensions
   * Stale: embedded with a different model or dimensions
   * Pending: no embedding yet
   */
  async embeddingCoverage(
    tenantId: string,
    model: string,
    dimensions: number,
  ): Promise<{ current: number; stale: number; pending: number }> {
    const [row] = await this.sequelize.query<{
      current: string;
      stale: string;
      pending: string;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE embedding IS NOT NULL
             AND embedding_model = :model AND embedding_dim = :dimensions
         ) AS current,
         count(*) FILTER (
           WHERE embedding IS NOT NULL
             AND (embedding_model IS DISTINCT FROM :model
                  OR embedding_dim IS DISTINCT FROM :dimensions)
         ) AS stale,
         count(*) FILTER (WHERE embedding IS NULL) AS pending
         FROM chunks WHERE tenant_id = :tenantId`,
      { type: QueryTypes.SELECT, replacements: { tenantId, model, dimensions } },
    );
    return { current: Number(row.current), stale: Number(row.stale), pending: Number(row.pending) };
  }

  /**
   * Count documents per repo, optionally filtered to a set of repo IDs
   */
  async countPagesByRepo(tenantId: string, scope: 'all' | string[]): Promise<Map<string, number>> {
    const rows = await this.sequelize.query<{ repo_id: string; pages: string }>(
      `SELECT d.repo_id, count(*) AS pages
         FROM documents d
        WHERE d.tenant_id = :tenantId
          AND (:all::boolean OR d.repo_id = ANY (CAST(:ids AS uuid[])))
        GROUP BY d.repo_id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId,
          all: scope === 'all',
          ids: scope === 'all' ? '{}' : `{${scope.join(',')}}`,
        },
      },
    );
    return new Map(rows.map((r) => [r.repo_id, Number(r.pages)]));
  }

  /**
   * Full link graph report for the admin dashboard
   *
   * Runs five queries in parallel: totals, most-linked pages (by inbound
   * edge count, excluding index pages), unlinked pages (no edges at all),
   * dangling edges (target document missing), and narrowing edges (crossing
   * into a page with a stricter grant)
   */
  async graphReport(tenantId: string, limit = 25): Promise<GraphReport> {
    const replacements = { tenantId, limit };
    const [totals, mostLinked, unlinked, dangling, narrowing] = await Promise.all([
      this.sequelize.query<{ edges: string; terms: string; pages: string }>(
        `SELECT
           (SELECT count(*) FROM document_edges WHERE tenant_id = :tenantId) AS edges,
           (SELECT count(*) FROM document_terms WHERE tenant_id = :tenantId) AS terms,
           (SELECT count(*) FROM documents WHERE tenant_id = :tenantId) AS pages`,
        { type: QueryTypes.SELECT, replacements },
      ),

      this.sequelize.query<GraphPageRow & { inbound: number }>(
        `SELECT t.repo_namespace, t.repo_slug, t.forge_key, t.slug_path, t.title,
                count(*)::int AS inbound
           FROM document_edges e
           ${EDGE_JOINS}
          WHERE e.tenant_id = :tenantId
          GROUP BY t.id, t.repo_namespace, t.repo_slug, t.forge_key, t.slug_path, t.title
          ORDER BY inbound DESC, t.title
          LIMIT :limit`,
        { type: QueryTypes.SELECT, replacements },
      ),

      this.sequelize.query<GraphPageRow>(
        `SELECT d.repo_namespace, d.repo_slug, d.forge_key, d.slug_path, d.title
           FROM documents d
          WHERE d.tenant_id = :tenantId
            AND d.is_index = false
            AND NOT EXISTS (
              SELECT 1 FROM document_edges e
               WHERE e.tenant_id = d.tenant_id
                 AND ((e.repo_id = d.repo_id AND e.source_slug_path = d.slug_path)
                   OR (e.target_repo_id = d.repo_id AND e.target_slug_path = d.slug_path))
            )
          ORDER BY d.repo_namespace, d.repo_slug, d.slug_path
          LIMIT :limit`,
        { type: QueryTypes.SELECT, replacements },
      ),

      this.sequelize.query<GraphEdgeRow>(
        `SELECT r.namespace, r.slug, e.source_slug_path, e.target_slug_path,
                ''::text AS detail
           FROM document_edges e
           JOIN repos r ON r.id = e.repo_id
          WHERE e.tenant_id = :tenantId
            AND NOT EXISTS (
              SELECT 1 FROM documents t
               WHERE t.tenant_id = e.tenant_id
                 AND t.repo_id   = e.target_repo_id
                 AND t.slug_path = e.target_slug_path
            )
          ORDER BY r.namespace, r.slug, e.source_slug_path
          LIMIT :limit`,
        { type: QueryTypes.SELECT, replacements },
      ),

      this.sequelize.query<GraphEdgeRow>(
        `SELECT r.namespace, r.slug, e.source_slug_path, e.target_slug_path,
                array_to_string(ARRAY(
                  SELECT unnest(s.effective_principals)
                  EXCEPT SELECT unnest(t.effective_principals)
                ), ', ') AS detail
           FROM document_edges e
           ${EDGE_JOINS}
           JOIN repos r ON r.id = e.repo_id
          WHERE e.tenant_id = :tenantId
            AND NOT (s.effective_principals <@ t.effective_principals)
          ORDER BY r.namespace, r.slug, e.source_slug_path
          LIMIT :limit`,
        { type: QueryTypes.SELECT, replacements },
      ),
    ]);

    return {
      edges: Number(totals[0]?.edges ?? 0),
      terms: Number(totals[0]?.terms ?? 0),
      pages: Number(totals[0]?.pages ?? 0),
      most_linked: mostLinked,
      unlinked,
      dangling,
      narrowing,
    };
  }
}
