/**
 * Paths crawlable by a principal
 *
 * crawlablePages returns indexable documents the caller can read, used for the
 * sitemap
 * reachablePaths returns every document, folder and asset the caller can reach,
 * used in integration tests to verify a full rebuild reproduces identical rows
 *
 * Documents and assets filter by effective_principals overlap
 * Folders are visible when at least one document inside them is readable
 */
import { Injectable } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';

import { Principal } from '../../common/principals';
import { toPgTextArray } from '../../db/pg-array';
import { getSequelize } from '../../db/sequelize';
import { authorizedSql, visibleFolderSql } from '../filter';

@Injectable()
export class CrawlRepository {
  constructor(private readonly sequelize: Sequelize = getSequelize()) {}

  /** Indexable pages the caller can read, ordered by namespace/slug/path */
  async crawlablePages(
    principals: Principal[],
    tenantId: string,
    limit: number,
  ): Promise<{ namespace: string; slug: string; forge_key: string; slug_path: string }[]> {
    return this.sequelize.query<{
      namespace: string;
      slug: string;
      forge_key: string;
      slug_path: string;
    }>(
      `SELECT d.repo_namespace AS namespace, d.repo_slug AS slug, d.forge_key, d.slug_path
         FROM documents d
        WHERE d.tenant_id = :tenantId
          AND d.indexable = true
          AND ${authorizedSql('d')}
        ORDER BY d.repo_namespace, d.repo_slug, d.slug_path
        LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, limit, principals: toPgTextArray(principals) },
      },
    );
  }

  /**
   * Every path the caller can reach, grouped by content type
   *
   * Three parallel queries return all documents, folders and assets the caller
   * is authorized to see, sorted alphabetically
   *
   * Not authorizedSql on folders: they lack effective_principals, so visibility
   * is derived from documents inside them
   */
  async reachablePaths(
    principals: Principal[],
    tenantId: string,
  ): Promise<{ documents: string[]; folders: string[]; assets: string[] }> {
    const [docs, folders, assets] = await Promise.all([
      this.sequelize.query<{ p: string }>(
        `SELECT r.namespace || '/' || r.slug ||
                CASE WHEN d.slug_path = '' THEN '' ELSE '/' || d.slug_path END AS p
           FROM documents d JOIN repos r ON r.id = d.repo_id
          WHERE d.tenant_id = :tenantId AND ${authorizedSql('d')}`,
        {
          type: QueryTypes.SELECT,
          replacements: { tenantId, principals: toPgTextArray(principals) },
        },
      ),
      this.sequelize.query<{ p: string }>(
        `SELECT r.namespace || '/' || r.slug ||
                CASE WHEN f.slug_path = '' THEN '' ELSE '/' || f.slug_path END AS p
           FROM folders f JOIN repos r ON r.id = f.repo_id
          WHERE f.tenant_id = :tenantId AND ${visibleFolderSql('f')}`,
        {
          type: QueryTypes.SELECT,
          replacements: { tenantId, principals: toPgTextArray(principals) },
        },
      ),
      this.sequelize.query<{ p: string }>(
        `SELECT r.namespace || '/' || r.slug || '/' || a.slug_path AS p
           FROM assets a JOIN repos r ON r.id = a.repo_id
          WHERE a.tenant_id = :tenantId AND ${authorizedSql('a')}`,
        {
          type: QueryTypes.SELECT,
          replacements: { tenantId, principals: toPgTextArray(principals) },
        },
      ),
    ]);
    return {
      documents: docs.map((r) => r.p).sort(),
      folders: folders.map((r) => r.p).sort(),
      assets: assets.map((r) => r.p).sort(),
    };
  }
}
