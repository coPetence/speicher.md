/**
 * Database access for document search
 *
 * Each method returns SearchHit rows using a different matching strategy
 * linkCountsWithin counts inbound links among a set of documents
 */

import { Injectable } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';

import { Principal } from '../../common/principals';
import { toPgTextArray } from '../../db/pg-array';
import { toVectorLiteral } from '../../db/vector';
import { getSequelize } from '../../db/sequelize';
import { VECTOR_DISTANCE_OPERATOR } from '../../embed/distance';
import { EDGE_JOINS, authorizedSql } from '../filter';
import { SearchHit, SearchOptions } from './types';
import { FUZZY_WORD_THRESHOLD, fuzzySql, fuzzyTerms } from './search-fuzzy';

@Injectable()
export class SearchRepository {
  constructor(private readonly sequelize: Sequelize = getSequelize()) {}

  /** Full-text search via PostgreSQL tsvector with German and simple configs */
  async searchKeyword(
    principals: Principal[],
    tenantId: string,
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchHit[]> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    return this.sequelize.query<SearchHit>(
      `WITH q AS (
         SELECT websearch_to_tsquery('german', public.speicher_unaccent(:query)) AS de,
                websearch_to_tsquery('simple', public.speicher_unaccent(:query)) AS si
       )
       SELECT d.repo_id, d.slug_path, d.title, d.icon, d.is_index, d.html,
              -- ts_headline inserts the mark tags but does not escape the document,
              -- so plain -- which has its entities decoded -- is escaped first. The
              -- three replaces are searchSemantic's, in ampersand-first order so the
              -- escapes are not re-escaped; the only unescaped tags left are the
              -- StartSel/StopSel marks this line adds. (No backticks in here: one
              -- inside a SQL template literal ends the template.)
              ts_headline(
                'german',
                replace(replace(replace(d.plain, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
                q.de,
                'MaxFragments=2, MinWords=8, MaxWords=28, StartSel=<mark>, StopSel=</mark>'
              ) AS snippet,
              -- Not a semantic hit, so there is no passage to cite. Spelled out
              -- rather than left absent: one row shape leaves this class, and a
              -- consumer that had to know which query produced a row would be a
              -- consumer that can get it wrong.
              NULL::integer AS chunk_ord,
              NULL::text AS chunk_text,
              (ts_rank_cd(d.tsv, q.de) + ts_rank_cd(d.tsv_simple, q.si)) AS rank,
              d.repo_namespace, d.repo_slug, d.forge_key
         FROM documents d, q
        WHERE d.tenant_id = :tenantId
          AND ${authorizedSql('d')}
          AND (:repoId::uuid IS NULL OR d.repo_id = :repoId::uuid)
          AND (
            :pathPrefix::text IS NULL
            OR d.slug_path = :pathPrefix::text
            OR d.slug_path LIKE :pathPrefix::text || '/%'
          )
          AND (:retrievalOnly::boolean = false OR d.indexable = true)
          AND (d.tsv @@ q.de OR d.tsv_simple @@ q.si)
        ORDER BY rank DESC, d.title
        LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId,
          query,
          principals: toPgTextArray(principals),
          limit,
          repoId: options.repoId ?? null,
          pathPrefix: options.pathPrefix ?? null,
          retrievalOnly: options.retrievalOnly ?? false,
        },
      },
    );
  }

  /** Trigram-based fuzzy search on chunk text and document titles
   *
   * Uses a transaction to set pg_trgm.word_similarity_threshold per query
   */
  async searchTrigram(
    principals: Principal[],
    tenantId: string,
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchHit[]> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const terms = fuzzyTerms(query);

    const need = Math.ceil(terms.length / 2);
    const chunk = fuzzySql(terms, 'public.speicher_unaccent(c.text)');
    const title = fuzzySql(terms, 'public.speicher_unaccent(d.title)');
    const termReplacements = Object.fromEntries(terms.map((t, i) => [`t${i}`, t]));

    return this.sequelize.transaction(async (transaction) => {
      await this.sequelize.query(
        `SELECT set_config('pg_trgm.word_similarity_threshold', :threshold, true)`,
        { transaction, replacements: { threshold: String(FUZZY_WORD_THRESHOLD) } },
      );
      return this.sequelize.query<SearchHit>(
        `SELECT d.repo_id, d.slug_path, d.title, d.icon, d.is_index, d.html,
                -- plain and chunk text both have their entities decoded, so the
                -- slice is escaped before it travels -- searchSemantic's three
                -- replaces, ampersand first. This path has no ts_headline, so there
                -- are no real tags at all in the result.
                replace(replace(replace(
                  COALESCE(p.passage, left(d.plain, 240)),
                  '&', '&amp;'), '<', '&lt;'), '>', '&gt;') AS snippet,
                m.ord AS chunk_ord,
                p.passage AS chunk_text,
                GREATEST(
                  COALESCE(m.score, 0),
                  similarity(public.speicher_unaccent(d.title), public.speicher_unaccent(:query)),
                  ${title.score}
                ) AS rank,
                d.repo_namespace, d.repo_slug, d.forge_key
           FROM documents d
           LEFT JOIN (
             -- The index drives this half: candidates come off chunks_text_trgm and
             -- are narrowed to readable pages by the join, never the reverse.
             SELECT DISTINCT ON (c.repo_id, c.slug_path)
                    c.repo_id, c.slug_path, c.ord, c.text, ${chunk.score} AS score
               FROM chunks c
              WHERE c.tenant_id = :tenantId
                AND ${chunk.any}
                AND ${chunk.count} >= :need
              ORDER BY c.repo_id, c.slug_path, score DESC, c.ord
           ) m ON m.repo_id = d.repo_id AND m.slug_path = d.slug_path
           -- The window is cut around the word nearest the query, not off the head
           -- of the chunk: a chunk runs to CHUNK_TARGET_CHARS and the word that
           -- matched is as likely to be at its end, where a plain left() drops the
           -- one thing the passage exists to show. Ties go to the longer word, since
           -- a three-letter word shares a leading trigram with half the query. Runs
           -- only for pages that already passed the filter below.
           LEFT JOIN LATERAL (
             SELECT substr(
                      m.text,
                      GREATEST(1, strpos(m.text, best.w) - 160),
                      480
                    ) AS passage
               FROM (
                 SELECT w
                   FROM regexp_split_to_table(m.text, '[[:space:]]+') AS w
                  WHERE length(w) >= 3
                  ORDER BY word_similarity(public.speicher_unaccent(w), public.speicher_unaccent(:query)) DESC,
                           length(w) DESC
                  LIMIT 1
               ) best
           ) p ON m.ord IS NOT NULL
          WHERE d.tenant_id = :tenantId
            AND ${authorizedSql('d')}
            AND (:repoId::uuid IS NULL OR d.repo_id = :repoId::uuid)
            AND (
              :pathPrefix::text IS NULL
              OR d.slug_path = :pathPrefix::text
              OR d.slug_path LIKE :pathPrefix::text || '/%'
            )
            AND (:retrievalOnly::boolean = false OR d.indexable = true)
            AND (
              m.ord IS NOT NULL
              -- A title is short enough to compare with the whole query, which is
              -- what finds "Where things live" from a sentence around it.
              OR public.speicher_unaccent(d.title) % public.speicher_unaccent(:query)
              OR ${title.count} >= :need
            )
          ORDER BY rank DESC, d.title
          LIMIT :limit`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            tenantId,
            query,
            need,
            ...termReplacements,
            principals: toPgTextArray(principals),
            limit,
            repoId: options.repoId ?? null,
            pathPrefix: options.pathPrefix ?? null,
            retrievalOnly: options.retrievalOnly ?? false,
          },
          transaction,
        },
      );
    });
  }

  /** Vector similarity search via cosine distance on chunk embeddings */
  async searchSemantic(
    principals: Principal[],
    tenantId: string,
    embedding: number[],
    model: string,
    dimensions: number,
    options: SearchOptions = {},
  ): Promise<SearchHit[]> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    return this.sequelize.query<SearchHit>(
      `SELECT repo_id, slug_path, title, icon, is_index, html, snippet, chunk_ord, chunk_text, rank,
              repo_namespace, repo_slug, forge_key
         FROM (
           SELECT DISTINCT ON (d.repo_id, d.slug_path)
                  d.repo_id, d.slug_path, d.title, d.icon, d.is_index, d.html,
                  -- The same passage twice, and deliberately: chunk_text is what
                  -- an agent quotes and snippet is what a page renders, and the
                  -- second has to be safe HTML. documents.plain has its entities decoded,
                  -- so a page documenting a script tag holds those characters
                  -- literally — escaping here rather than at render is the same
                  -- rule ingest follows for the stored HTML.
                  replace(replace(replace(left(c.text, 480), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
                    AS snippet,
                  c.ord AS chunk_ord,
                  left(c.text, 480) AS chunk_text,
                  -- Cosine distance is 0 for identical direction and 2 for opposite,
                  -- so this is a similarity in the same "bigger is better" sense the
                  -- other two rankers use. Fusion is by rank rather than by value,
                  -- but a rank column that meant the opposite of its neighbours
                  -- would be read wrongly by the first thing that looked at it.
                  1 - (c.embedding ${VECTOR_DISTANCE_OPERATOR} CAST(:embedding AS vector)) AS rank,
                  d.repo_namespace, d.repo_slug, d.forge_key
             FROM chunks c
             JOIN documents d
               ON d.tenant_id = c.tenant_id
              AND d.repo_id = c.repo_id
              AND d.slug_path = c.slug_path
            WHERE c.tenant_id = :tenantId
              AND c.embedding IS NOT NULL
              AND c.embedding_model = :model
              AND c.embedding_dim = :dimensions
              AND ${authorizedSql('d')}
              AND (:repoId::uuid IS NULL OR d.repo_id = :repoId::uuid)
              AND (
                :pathPrefix::text IS NULL
                OR d.slug_path = :pathPrefix::text
                OR d.slug_path LIKE :pathPrefix::text || '/%'
              )
              AND (:retrievalOnly::boolean = false OR d.indexable = true)
            ORDER BY d.repo_id, d.slug_path,
                     c.embedding ${VECTOR_DISTANCE_OPERATOR} CAST(:embedding AS vector)
         ) nearest
        ORDER BY rank DESC, title
        LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId,
          embedding: toVectorLiteral(embedding),
          model,
          dimensions,
          principals: toPgTextArray(principals),
          limit,
          repoId: options.repoId ?? null,
          pathPrefix: options.pathPrefix ?? null,
          retrievalOnly: options.retrievalOnly ?? false,
        },
      },
    );
  }

  /** Inbound link counts within a given set of documents */
  async linkCountsWithin(
    principals: Principal[],
    tenantId: string,
    members: { repo_id: string; slug_path: string }[],
  ): Promise<Map<string, number>> {
    if (members.length === 0) return new Map();
    const rows = await this.sequelize.query<{
      repo_id: string;
      slug_path: string;
      inbound: number;
    }>(
      `WITH members AS (
         SELECT * FROM unnest(CAST(:repoIds AS uuid[]), CAST(:slugPaths AS text[]))
                       AS m(repo_id, slug_path)
       )
       SELECT e.target_repo_id AS repo_id, e.target_slug_path AS slug_path, count(*)::int AS inbound
         FROM document_edges e
         ${EDGE_JOINS}
         JOIN members ms ON ms.repo_id = e.repo_id AND ms.slug_path = e.source_slug_path
         JOIN members mt ON mt.repo_id = e.target_repo_id AND mt.slug_path = e.target_slug_path
        WHERE e.tenant_id = :tenantId
          AND ${authorizedSql('s')}
          AND ${authorizedSql('t')}
        GROUP BY 1, 2`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId,
          repoIds: toPgTextArray(members.map((m) => m.repo_id)),
          slugPaths: toPgTextArray(members.map((m) => m.slug_path)),
          principals: toPgTextArray(principals),
        },
      },
    );
    return new Map(rows.map((r) => [`${r.repo_id}${r.slug_path}`, r.inbound]));
  }
}
