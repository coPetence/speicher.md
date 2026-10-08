/**
 * Row‑level permission filters for Sequelize and raw SQL
 *
 * Every document row carries an `effective_principals` text array column listing the
 * principals (users, groups, roles) that can see it.  A query is scoped by intersecting
 * that column with the caller's principal set via the PostgreSQL `&&` (overlap) operator.
 *
 * The same overlap pattern is used for document visibility within a folder subtree:
 * a folder is visible to a caller only if that folder contains at least one document the
 * caller is authorised to see.
 */

import { Op, WhereOptions } from 'sequelize';

import { Principal } from '../common/principals';

export const EFFECTIVE_PRINCIPALS_COLUMN = 'effective_principals';

export function authorizedScope(principals: Principal[]): WhereOptions {
  return { [EFFECTIVE_PRINCIPALS_COLUMN]: { [Op.overlap]: principals } };
}

export function authorizedSql(alias: string, param = 'principals'): string {
  return `${alias}.${EFFECTIVE_PRINCIPALS_COLUMN} && CAST(:${param} AS text[])`;
}

export function visibleFolderSql(folderAlias: string, documentTable = 'documents'): string {
  return `EXISTS (
    SELECT 1 FROM ${documentTable} d
     WHERE d.tenant_id = ${folderAlias}.tenant_id
       AND d.repo_id   = ${folderAlias}.repo_id
       AND (
         ${folderAlias}.slug_path = ''
         OR d.slug_path = ${folderAlias}.slug_path
         OR d.slug_path LIKE ${folderAlias}.slug_path || '/%'
       )
       AND ${authorizedSql('d')}
  )`;
}

/**
 * Document-edge SQL fragments for graph queries
 *
 * The `document_edges` table stores links between documents by their keys
 * (repo_id + slug_path).  This join resolves those keys to full document rows
 * in one pass, yielding the source endpoint as `s` and the target endpoint as
 * `t`
 *
 * Used by graph, report, and search queries to avoid repeating the same JOIN
 */
export const EDGE_JOINS = `
    JOIN documents s ON s.tenant_id = e.tenant_id
                    AND s.repo_id   = e.repo_id
                    AND s.slug_path = e.source_slug_path
    JOIN documents t ON t.tenant_id = e.tenant_id
                    AND t.repo_id   = e.target_repo_id
                    AND t.slug_path = e.target_slug_path`;
