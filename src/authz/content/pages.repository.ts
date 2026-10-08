/**
 * Content queries with authorization
 *
 * Every method takes a principal list and filters results to rows the caller can see
 * authorizedSql checks effective_principals overlap; visibleFolderSql checks that at
 * least one authorized document exists under the folder
 * getPage also computes is_public by checking against PUBLIC_PRINCIPAL
 *
 * A folder is visible to the caller when at least one child page is
 */
import { Injectable } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';

import { PUBLIC_PRINCIPAL, Principal } from '../../common/principals';
import { toPgTextArray } from '../../db/pg-array';
import { getSequelize } from '../../db/sequelize';
import { authorizedSql, visibleFolderSql } from '../filter';
import { AssetRow, ChildRow, PageRow } from './types';

@Injectable()
export class PageRepository {
  constructor(private readonly sequelize: Sequelize = getSequelize()) {}

  /** Full page document by slug path, with is_public flag */
  async getPage(
    principals: Principal[],
    tenantId: string,
    repoId: string,
    slugPath: string,
  ): Promise<PageRow | null> {
    const rows = await this.sequelize.query<PageRow>(
      `SELECT d.id, d.repo_id, d.slug_path, d.source_path, d.parent_path, d.title,
              d.description, d.html, d.markdown, d.is_index, d.indexable, d.icon,
              d.commit_sha, d.updated_at, d.repo_namespace, d.repo_slug, d.forge_key,
              ${authorizedSql('d', 'publicPrincipals')} AS is_public
         FROM documents d
        WHERE d.tenant_id = :tenantId
          AND d.repo_id = :repoId
          AND d.slug_path = :slugPath
          AND ${authorizedSql('d')}
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId,
          repoId,
          slugPath,
          principals: toPgTextArray(principals),
          publicPrincipals: toPgTextArray([PUBLIC_PRINCIPAL]),
        },
      },
    );
    return rows[0] ?? null;
  }

  /** Whether a folder has any visible page under it */
  async folderVisible(
    principals: Principal[],
    tenantId: string,
    repoId: string,
    slugPath: string,
  ): Promise<boolean> {
    const rows = await this.sequelize.query<{ visible: boolean }>(
      `SELECT ${visibleFolderSql('f')} AS visible
         FROM folders f
        WHERE f.tenant_id = :tenantId AND f.repo_id = :repoId AND f.slug_path = :slugPath
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, repoId, slugPath, principals: toPgTextArray(principals) },
      },
    );
    return rows[0]?.visible === true;
  }

  /** Folder metadata (title, icon) if visible to the caller */
  async getFolder(
    principals: Principal[],
    tenantId: string,
    repoId: string,
    slugPath: string,
  ): Promise<{
    slug_path: string;
    title: string;
    icon: string | null;
  } | null> {
    const rows = await this.sequelize.query<{
      slug_path: string;
      title: string;
      icon: string | null;
    }>(
      `SELECT f.slug_path, f.title, f.icon
         FROM folders f
        WHERE f.tenant_id = :tenantId AND f.repo_id = :repoId AND f.slug_path = :slugPath
          AND ${visibleFolderSql('f')}
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, repoId, slugPath, principals: toPgTextArray(principals) },
      },
    );
    return rows[0] ?? null;
  }

  /** Visible pages and subfolders under a parent path, sorted */
  async listChildren(
    principals: Principal[],
    tenantId: string,
    repoId: string,
    parentPath: string,
  ): Promise<ChildRow[]> {
    return this.sequelize.query<ChildRow>(
      `SELECT * FROM (
         SELECT 'page'::text AS kind, d.slug_path, d.title, d.description, d.icon,
                d.sort_order, d.sort_key
           FROM documents d
          WHERE d.tenant_id = :tenantId
            AND d.repo_id = :repoId
            AND d.parent_path = :parentPath
            AND d.slug_path <> :parentPath
            AND ${authorizedSql('d')}
         UNION ALL
         SELECT 'folder'::text AS kind, f.slug_path, f.title, NULL::text AS description,
                f.icon, f.sort_order, f.sort_key
           FROM folders f
          WHERE f.tenant_id = :tenantId
            AND f.repo_id = :repoId
            AND f.parent_path = :parentPath
            AND ${visibleFolderSql('f')}
       ) AS children
        ORDER BY sort_order IS NULL, sort_order, sort_key, slug_path`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, repoId, parentPath, principals: toPgTextArray(principals) },
      },
    );
  }

  /** All visible pages and folders in a repo, for navigation */
  async navNodes(principals: Principal[], tenantId: string, repoId: string): Promise<ChildRow[]> {
    return this.sequelize.query<ChildRow>(
      `SELECT * FROM (
         SELECT 'page'::text AS kind, d.slug_path, d.title, d.description, d.icon,
                d.sort_order, d.sort_key
           FROM documents d
          WHERE d.tenant_id = :tenantId AND d.repo_id = :repoId AND ${authorizedSql('d')}
         UNION ALL
         SELECT 'folder'::text AS kind, f.slug_path, f.title, NULL::text AS description,
                f.icon, f.sort_order, f.sort_key
           FROM folders f
          WHERE f.tenant_id = :tenantId AND f.repo_id = :repoId AND ${visibleFolderSql('f')}
       ) AS nodes
        ORDER BY sort_order IS NULL, sort_order, sort_key, slug_path`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, repoId, principals: toPgTextArray(principals) },
      },
    );
  }

  /** Repos with at least one visible page, including optional authorized cover image */
  async listVisibleRepos(
    principals: Principal[],
    tenantId: string,
  ): Promise<
    {
      repo_id: string;
      namespace: string;
      slug: string;
      forge_key: string;
      title: string;
      cover_path: string | null;
    }[]
  > {
    return this.sequelize.query(
      `SELECT r.id AS repo_id, r.namespace, r.slug,
              fo.key AS forge_key,
              COALESCE(r.display_title, r.slug) AS title,
              cover.slug_path AS cover_path
         FROM repos r
         JOIN forges fo ON fo.id = r.forge_id
         LEFT JOIN LATERAL (
           SELECT a.slug_path
             FROM assets a
            WHERE a.tenant_id = r.tenant_id
              AND a.repo_id = r.id
              AND a.slug_path = r.cover_path
              AND ${authorizedSql('a')}
            LIMIT 1
         ) cover ON true
        WHERE r.tenant_id = :tenantId
          AND EXISTS (
            SELECT 1 FROM documents d
             WHERE d.repo_id = r.id AND ${authorizedSql('d')}
          )
        ORDER BY r.namespace, r.slug`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, principals: toPgTextArray(principals) },
      },
    );
  }

  /** Cover image asset path for a repo, if the asset is authorized */
  async repoCover(
    principals: Principal[],
    tenantId: string,
    repoId: string,
  ): Promise<string | null> {
    const rows = await this.sequelize.query<{ slug_path: string }>(
      `SELECT a.slug_path
         FROM repos r
         JOIN assets a ON a.tenant_id = r.tenant_id
                      AND a.repo_id   = r.id
                      AND a.slug_path = r.cover_path
        WHERE r.tenant_id = :tenantId AND r.id = :repoId
          AND ${authorizedSql('a')}
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, repoId, principals: toPgTextArray(principals) },
      },
    );
    return rows[0]?.slug_path ?? null;
  }

  /** Asset metadata by slug path, with authorization */
  async getAsset(
    principals: Principal[],
    tenantId: string,
    repoId: string,
    slugPath: string,
  ): Promise<AssetRow | null> {
    const rows = await this.sequelize.query<AssetRow>(
      `SELECT a.id, a.repo_id, a.slug_path, a.mime, a.size_bytes::bigint AS size_bytes, a.content_hash
         FROM assets a
        WHERE a.tenant_id = :tenantId AND a.repo_id = :repoId AND a.slug_path = :slugPath
          AND ${authorizedSql('a')}
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, repoId, slugPath, principals: toPgTextArray(principals) },
      },
    );
    const row = rows[0];
    return row ? { ...row, size_bytes: Number(row.size_bytes) } : null;
  }

  /** Whether a slug path resolves to a page or a visible folder */
  async resolveRedirectTarget(
    principals: Principal[],
    tenantId: string,
    repoId: string,
    slugPath: string,
  ): Promise<boolean> {
    const page = await this.getPage(principals, tenantId, repoId, slugPath);
    if (page) return true;
    return this.folderVisible(principals, tenantId, repoId, slugPath);
  }
}
