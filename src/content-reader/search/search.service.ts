/**
 * Search backed by keyword (fts + fuzzy trigram) with link-boost reranking
 *
 * KeywordSearch runs FTS and fuzzy trigram together and fuses them by rank
 * HybridSearch merges keyword and semantic results via reciprocal-rank fusion
 * Falls back to keyword when no embedding client is configured or embedding fails
 * SearchService delegates to whichever provider is wired (keyword or hybrid)
 *
 * Not a vector store; the embedding model dimensions come from the client
 */

import { Injectable } from '@nestjs/common';

import { ResolvedCaller } from '../../authz/caller';
import { SearchHit } from '../../authz/content/types';
import { SearchRepository } from '../../authz/content/search.repository';
import { Logger, rootLogger } from '../../common/logger';
import { ConfigService } from '../../config/config.service';
import { EmbeddingClient } from '../../embed/client';

export interface SearchQueryOptions {
  limit?: number;
  repoId?: string;

  pathPrefix?: string;

  retrievalOnly?: boolean;
}

export interface SearchProvider {
  search(caller: ResolvedCaller, query: string, options?: SearchQueryOptions): Promise<SearchHit[]>;
}

const LINK_BOOST = 0.25;

const BOOST_POOL = 3;

const RRF_K = 60;

function prepare(
  caller: ResolvedCaller,
  query: string,
  options: SearchQueryOptions,
  config: ConfigService,
): { query: string; limit: number; boosting: boolean; pool: SearchQueryOptions } | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;

  if (caller.principals.length === 0) return null;

  const limit = options.limit ?? 20;
  const boosting = config.graph.search_boost;
  return {
    query: trimmed,
    limit,
    boosting,
    pool: boosting ? { ...options, limit: Math.min(limit * BOOST_POOL, 100) } : options,
  };
}

async function applyLinkBoost(
  content: SearchRepository,
  caller: ResolvedCaller,
  hits: SearchHit[],
  limit: number,
  boosting: boolean,
): Promise<SearchHit[]> {
  if (!boosting || hits.length < 2) return hits.slice(0, limit);

  const counts = await content.linkCountsWithin(caller.principals, caller.tenantId, hits);

  return [...hits].sort((a, b) => scoreOf(b, counts) - scoreOf(a, counts)).slice(0, limit);
}

export function fuseByRank(lists: SearchHit[][], limit: number): SearchHit[] {
  const scores = new Map<string, number>();
  const rows = new Map<string, SearchHit>();

  for (const list of lists) {
    list.forEach((hit, index) => {
      const key = `${hit.repo_id} ${hit.slug_path}`;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + index + 1));

      const held = rows.get(key);
      if (!held) {
        rows.set(key, hit);
        return;
      }

      if (held.chunk_ord === null && hit.chunk_ord !== null) {
        rows.set(key, { ...held, chunk_ord: hit.chunk_ord, chunk_text: hit.chunk_text });
      }
    });
  }

  return [...rows.entries()]
    .map(([key, hit]) => ({ ...hit, rank: scores.get(key) as number }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);
}

@Injectable()
export class KeywordSearch implements SearchProvider {
  constructor(
    private readonly content: SearchRepository,
    private readonly config: ConfigService,
  ) {}

  async search(
    caller: ResolvedCaller,
    query: string,
    options: SearchQueryOptions = {},
  ): Promise<SearchHit[]> {
    const prepared = prepare(caller, query, options, this.config);
    if (!prepared) return [];

    const hits = await this.candidates(caller, prepared.query, prepared.pool);
    return applyLinkBoost(this.content, caller, hits, prepared.limit, prepared.boosting);
  }

  async candidates(
    caller: ResolvedCaller,
    query: string,
    pool: SearchQueryOptions,
  ): Promise<SearchHit[]> {
    // Both, always, rather than fuzzy as a fallback: a fallback runs only when
    // full-text finds nothing, so one exact hit anywhere hid every page the query
    // misspelled. Fused by rank for the reason HybridSearch fuses — ts_rank_cd and
    // word_similarity share no unit — and a page both find rises. On a tie the
    // full-text row comes first (the sort is stable and it is inserted first),
    // and a page both find keeps its highlighted snippet and gains the passage.
    const [keyword, fuzzy] = await Promise.all([
      this.content.searchKeyword(caller.principals, caller.tenantId, query, pool),
      this.content.searchTrigram(caller.principals, caller.tenantId, query, pool),
    ]);
    if (fuzzy.length === 0) return keyword;
    if (keyword.length === 0) return fuzzy;
    return fuseByRank([keyword, fuzzy], pool.limit ?? 20);
  }
}

@Injectable()
export class HybridSearch implements SearchProvider {
  private readonly log: Logger = rootLogger.child('search');

  constructor(
    private readonly content: SearchRepository,
    private readonly config: ConfigService,
    private readonly keyword: KeywordSearch,
    private readonly client: EmbeddingClient | null,
  ) {}

  async search(
    caller: ResolvedCaller,
    query: string,
    options: SearchQueryOptions = {},
  ): Promise<SearchHit[]> {
    if (!this.client) return this.keyword.search(caller, query, options);

    const prepared = prepare(caller, query, options, this.config);
    if (!prepared) return [];

    const [lexical, semantic] = await Promise.all([
      this.keyword.candidates(caller, prepared.query, prepared.pool),
      this.semantic(caller, prepared.query, prepared.pool),
    ]);

    const fused =
      semantic.length === 0
        ? lexical
        : fuseByRank([lexical, semantic], prepared.pool.limit ?? prepared.limit);
    return applyLinkBoost(this.content, caller, fused, prepared.limit, prepared.boosting);
  }

  private async semantic(
    caller: ResolvedCaller,
    query: string,
    pool: SearchQueryOptions,
  ): Promise<SearchHit[]> {
    const client = this.client as EmbeddingClient;
    let embedding: number[];
    try {
      [embedding] = await client.embed([query]);
    } catch (err) {
      this.log.error('query could not be embedded; keyword results only', {
        error: (err as Error).message,
      });
      return [];
    }
    if (!embedding) return [];

    return this.content.searchSemantic(
      caller.principals,
      caller.tenantId,
      embedding,
      client.model,
      client.dimensions,
      pool,
    );
  }
}

function scoreOf(hit: SearchHit, counts: Map<string, number>): number {
  return hit.rank * (1 + LINK_BOOST * (counts.get(`${hit.repo_id} ${hit.slug_path}`) ?? 0));
}

@Injectable()
export class SearchService implements SearchProvider {
  constructor(private readonly provider: SearchProvider) {}

  search(
    caller: ResolvedCaller,
    query: string,
    options?: SearchQueryOptions,
  ): Promise<SearchHit[]> {
    return this.provider.search(caller, query, options);
  }
}
