/**
 * Page view and search analytics queries
 *
 * Uses HyperLogLog sketches for the readers count: exact COUNT(DISTINCT) does not
 * scale to a large readership within the time budget of the analytics dashboard
 *
 * Queries day-level rows from `page_views` and row-level misses from `search_misses`
 *
 * eslint-disable because `restricted-syntax` forbids Sequelize's template-literal
 * SQL; each query is built this way and the file is read as a unit
 */
import { Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';

import { toPgTextArray } from '../../db/pg-array';
import { getSequelize } from '../../db/sequelize';
import { Granularity } from './buckets';
import { estimateSketch, unionSketch } from './hll';

export interface PageCount {
  repoNamespace: string;
  repoSlug: string;
  forgeKey: string;
  slugPath: string;
  title: string;
  webViews: number;
  mcpViews: number;

  readers: number; // Estimated distinct reader HyperLogLog
}

export interface SeriesPoint {
  bucket: Date;
  webViews: number;
  mcpViews: number;
}

export interface NeverRead {
  repoNamespace: string;
  repoSlug: string;
  slugPath: string;
  title: string;
}

export interface SearchMiss {
  query: string;
  misses: number;
}

export interface Totals {
  webViews: number;
  mcpViews: number;
  pagesRead: number;
  pagesTotal: number;
}

/* eslint-disable no-restricted-syntax */
@Injectable()
export class AnalyticsRepository {
  async totals(tenantId: string, since: Date): Promise<Totals> {
    const [row] = await getSequelize().query<{
      web_views: string;
      mcp_views: string;
      pages_read: string;
    }>(
      `SELECT
         COALESCE(SUM(views) FILTER (WHERE surface = 'web'), 0) AS web_views,
         COALESCE(SUM(views) FILTER (WHERE surface = 'mcp'), 0) AS mcp_views,
         COUNT(DISTINCT (repo_id, slug_path))                   AS pages_read
       FROM page_views
       WHERE tenant_id = :tenantId AND bucket >= :since AND granularity = 'day'`,
      { type: QueryTypes.SELECT, replacements: { tenantId, since } },
    );

    const [corpus] = await getSequelize().query<{ pages_total: string }>(
      `SELECT COUNT(*) AS pages_total FROM documents WHERE tenant_id = :tenantId`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );

    return {
      webViews: Number(row?.web_views ?? 0),
      mcpViews: Number(row?.mcp_views ?? 0),
      pagesRead: Number(row?.pages_read ?? 0),
      pagesTotal: Number(corpus?.pages_total ?? 0),
    };
  }

  /**
   * Top N pages by total views
   *
   * Inner join drops pages whose document was deleted. HyperLogLog readers unioned
   * across surfaces then estimated
   */
  async topPages(tenantId: string, since: Date, limit: number): Promise<PageCount[]> {
    const rows = await getSequelize().query<{
      repo_id: string;
      slug_path: string;
      title: string;
      repo_namespace: string;
      repo_slug: string;
      forge_key: string;
      web_views: string;
      mcp_views: string;
    }>(
      `SELECT
         v.repo_id, v.slug_path,
         d.title, r.namespace AS repo_namespace, r.slug AS repo_slug, f.key AS forge_key,
         COALESCE(SUM(v.views) FILTER (WHERE v.surface = 'web'), 0) AS web_views,
         COALESCE(SUM(v.views) FILTER (WHERE v.surface = 'mcp'), 0) AS mcp_views
       FROM page_views v
       JOIN repos r ON r.id = v.repo_id
       JOIN forges f ON f.id = r.forge_id
       -- An inner join, so a counter whose page has since been deleted from the
       -- repository drops out of the report rather than being listed as a path that
       -- no longer exists. The row stays in the table until retention takes it: it
       -- is still true that the page was read.
       JOIN documents d
         ON d.tenant_id = v.tenant_id AND d.repo_id = v.repo_id AND d.slug_path = v.slug_path
       WHERE v.tenant_id = :tenantId AND v.bucket >= :since AND v.granularity = 'day'
       GROUP BY v.repo_id, v.slug_path, d.title, r.namespace, r.slug, f.key
       ORDER BY (COALESCE(SUM(v.views), 0)) DESC, d.title ASC
       LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { tenantId, since, limit } },
    );
    if (rows.length === 0) return [];

    const sketches = await getSequelize().query<{
      repo_id: string;
      slug_path: string;
      readers: Buffer | null;
    }>(
      `SELECT repo_id, slug_path, readers
         FROM page_views
        WHERE tenant_id = :tenantId AND bucket >= :since AND granularity = 'day'
          AND readers IS NOT NULL
          -- Two-argument UNNEST in FROM zips the arrays into pairs; the same two
          -- calls in a select list is a different, looser construct. Both casts go
          -- through toPgTextArray, or Sequelize expands the JS array into a SQL
          -- list and the cast becomes a syntax error.
          -- (No backticks in here: one inside a SQL template literal ends the
          -- template, and the compiler points at the line after.)
          AND (repo_id, slug_path) IN (
            SELECT * FROM UNNEST(CAST(:repoIds AS uuid[]), CAST(:slugPaths AS text[]))
          )`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId,
          since,
          repoIds: toPgTextArray(rows.map((r) => r.repo_id)),
          slugPaths: toPgTextArray(rows.map((r) => r.slug_path)),
        },
      },
    );

    const reach = new Map<string, Buffer>();
    for (const row of sketches) {
      const key = `${row.repo_id} ${row.slug_path}`;
      reach.set(key, unionSketch(reach.get(key) ?? null, row.readers));
    }

    return rows.map((row) => ({
      repoNamespace: row.repo_namespace,
      repoSlug: row.repo_slug,
      forgeKey: row.forge_key,
      slugPath: row.slug_path,
      title: row.title,
      webViews: Number(row.web_views),
      mcpViews: Number(row.mcp_views),
      readers: estimateSketch(reach.get(`${row.repo_id} ${row.slug_path}`) ?? null),
    }));
  }

  async series(tenantId: string, since: Date, granularity: Granularity): Promise<SeriesPoint[]> {
    const rows = await getSequelize().query<{
      bucket: Date;
      web_views: string;
      mcp_views: string;
    }>(
      `SELECT bucket,
              COALESCE(SUM(views) FILTER (WHERE surface = 'web'), 0) AS web_views,
              COALESCE(SUM(views) FILTER (WHERE surface = 'mcp'), 0) AS mcp_views
         FROM page_views
        WHERE tenant_id = :tenantId AND bucket >= :since AND granularity = :granularity
        GROUP BY bucket
        ORDER BY bucket ASC`,
      { type: QueryTypes.SELECT, replacements: { tenantId, since, granularity } },
    );
    return rows.map((row) => ({
      bucket: new Date(row.bucket),
      webViews: Number(row.web_views),
      mcpViews: Number(row.mcp_views),
    }));
  }

  /**
   * Documents with no page views since the cutoff
   *
   * Separate COUNT repeats the anti-join instead of wrapping the paginated query
   * because it is often faster
   */
  async neverRead(
    tenantId: string,
    since: Date,
    limit: number,
  ): Promise<{ rows: NeverRead[]; total: number }> {
    const rows = await getSequelize().query<{
      repo_namespace: string;
      repo_slug: string;
      slug_path: string;
      title: string;
    }>(
      `SELECT r.namespace AS repo_namespace, r.slug AS repo_slug, d.slug_path, d.title
         FROM documents d
         JOIN repos r ON r.id = d.repo_id
        WHERE d.tenant_id = :tenantId
          AND NOT EXISTS (
            SELECT 1 FROM page_views v
             WHERE v.tenant_id = d.tenant_id AND v.repo_id = d.repo_id
               AND v.slug_path = d.slug_path AND v.bucket >= :since
          )
        ORDER BY r.namespace, r.slug, d.slug_path
        LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { tenantId, since, limit } },
    );

    const [count] = await getSequelize().query<{ total: string }>(
      `SELECT COUNT(*) AS total
         FROM documents d
        WHERE d.tenant_id = :tenantId
          AND NOT EXISTS (
            SELECT 1 FROM page_views v
             WHERE v.tenant_id = d.tenant_id AND v.repo_id = d.repo_id
               AND v.slug_path = d.slug_path AND v.bucket >= :since
          )`,
      { type: QueryTypes.SELECT, replacements: { tenantId, since } },
    );

    return {
      rows: rows.map((row) => ({
        repoNamespace: row.repo_namespace,
        repoSlug: row.repo_slug,
        slugPath: row.slug_path,
        title: row.title,
      })),
      total: Number(count?.total ?? 0),
    };
  }

  async searchMisses(tenantId: string, since: Date, limit: number): Promise<SearchMiss[]> {
    const rows = await getSequelize().query<{ query: string; misses: string }>(
      `SELECT query, SUM(misses) AS misses
         FROM search_misses
        WHERE tenant_id = :tenantId AND bucket >= :since
        GROUP BY query
        ORDER BY SUM(misses) DESC, query ASC
        LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { tenantId, since, limit } },
    );
    return rows.map((row) => ({ query: row.query, misses: Number(row.misses) }));
  }
}
/* eslint-enable no-restricted-syntax */
