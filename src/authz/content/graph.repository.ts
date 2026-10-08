import { Injectable } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';

import { Principal } from '../../common/principals';
import { toPgTextArray } from '../../db/pg-array';
import { getSequelize } from '../../db/sequelize';
import { EDGE_JOINS, authorizedSql } from '../filter';
import { RelatedRow, TermRow } from './types';

/**
 * Document graph queries
 *
 * Reads from document_edges (links between documents) and document_terms (tag
 * assignments). Every query applies the caller's authorization via
 * authorizedSql
 */
@Injectable()
export class GraphRepository {
  constructor(private readonly sequelize: Sequelize = getSequelize()) {}

  /**
   * Outbound and inbound links for a document
   *
   * Outbound: documents whose slug_path appears as a link target in this page
   * Inbound: documents that link to this page
   *
   * Caps are clamped: outbound [1, 500], inbound [1, 50]
   * Outbound ordered by ordinal (position in source), inbound by sort_key then
   * slug_path
   * DISTINCT ON deduplicates when multiple edges reference the same target
   */
  async relatedTo(
    principals: Principal[],
    tenantId: string,
    repoId: string,
    slugPath: string,
    caps: { outbound: number; inbound: number },
  ): Promise<{ outbound: RelatedRow[]; inbound: RelatedRow[] }> {
    const columns = (alias: string) =>
      `${alias}.repo_id, ${alias}.slug_path, ${alias}.title, ${alias}.description, ${alias}.icon,
       ${alias}.repo_namespace, ${alias}.repo_slug, ${alias}.forge_key`;
    const replacements = {
      tenantId,
      repoId,
      slugPath,
      outboundLimit: Math.min(Math.max(caps.outbound, 1), 500),
      inboundLimit: Math.min(Math.max(caps.inbound, 1), 50),
      principals: toPgTextArray(principals),
    };

    const [outbound, inbound] = await Promise.all([
      // Documents this page links to (authorization on both source and target)
      this.sequelize.query<RelatedRow>(
        `SELECT * FROM (
           SELECT DISTINCT ON (t.id) ${columns('t')}, e.target_fragment AS fragment, e.ordinal
             FROM document_edges e
             ${EDGE_JOINS}
            WHERE e.tenant_id = :tenantId
              AND e.repo_id = :repoId
              AND e.source_slug_path = :slugPath
              AND ${authorizedSql('s')}
              AND ${authorizedSql('t')}
            ORDER BY t.id, e.ordinal
         ) rel
          ORDER BY rel.ordinal
          LIMIT :outboundLimit`,
        { type: QueryTypes.SELECT, replacements },
      ),
      // Documents linking to this page
      this.sequelize.query<RelatedRow>(
        `SELECT * FROM (
           SELECT DISTINCT ON (s.id) ${columns('s')}, ''::text AS fragment, s.sort_key
             FROM document_edges e
             ${EDGE_JOINS}
            WHERE e.tenant_id = :tenantId
              AND e.target_repo_id = :repoId
              AND e.target_slug_path = :slugPath
              AND ${authorizedSql('s')}
              AND ${authorizedSql('t')}
            ORDER BY s.id
         ) rel
          ORDER BY rel.sort_key, rel.slug_path
          LIMIT :inboundLimit`,
        { type: QueryTypes.SELECT, replacements },
      ),
    ]);
    return { outbound, inbound };
  }

  /**
   * Tags assigned to a document, in ordinal order
   */
  async termsFor(
    principals: Principal[],
    tenantId: string,
    repoId: string,
    slugPath: string,
  ): Promise<TermRow[]> {
    return this.sequelize.query<TermRow>(
      `SELECT dt.term, dt.label
         FROM document_terms dt
         JOIN documents d ON d.tenant_id = dt.tenant_id
                         AND d.repo_id   = dt.repo_id
                         AND d.slug_path = dt.source_slug_path
        WHERE dt.tenant_id = :tenantId
          AND dt.repo_id = :repoId
          AND dt.source_slug_path = :slugPath
          AND ${authorizedSql('d')}
        ORDER BY dt.ordinal`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, repoId, slugPath, principals: toPgTextArray(principals) },
      },
    );
  }

  /**
   * Documents tagged with a term, ordered by repo then sort_key then slug_path
   */
  async listByTerm(
    principals: Principal[],
    tenantId: string,
    term: string,
    limit = 200,
  ): Promise<RelatedRow[]> {
    return this.sequelize.query<RelatedRow>(
      `SELECT d.repo_id, d.slug_path, d.title, d.description, d.icon,
              ''::text AS fragment, d.repo_namespace, d.repo_slug, d.forge_key
         FROM document_terms dt
         JOIN documents d ON d.tenant_id = dt.tenant_id
                         AND d.repo_id   = dt.repo_id
                         AND d.slug_path = dt.source_slug_path
        WHERE dt.tenant_id = :tenantId
          AND dt.term = :term
          AND ${authorizedSql('d')}
        ORDER BY d.repo_namespace, d.repo_slug, d.sort_key, d.slug_path
        LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId,
          term: term.toLowerCase(),
          limit: Math.min(Math.max(limit, 1), 500),
          principals: toPgTextArray(principals),
        },
      },
    );
  }
}
