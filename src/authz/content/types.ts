/**
 * Row shapes for content database queries
 *
 * Each interface maps the column aliases from a repository SQL query
 * A nullable field is either an optional DB column or one populated by
 * only some of the queries returning that shape
 */

export interface PageRow {
  id: string;
  repo_id: string;
  slug_path: string;
  source_path: string;
  parent_path: string;
  title: string;
  description: string | null;
  html: string;
  markdown: string;
  is_index: boolean;
  indexable: boolean;

  is_public: boolean; // Whether the PUBLIC_PRINCIPAL can see this page
  icon: string | null;
  commit_sha: string;
  updated_at: Date;
  repo_namespace: string;
  repo_slug: string;
  forge_key: string;
}

/** A page or folder node in the tree navigation */
export interface ChildRow {
  kind: 'page' | 'folder';
  slug_path: string;
  title: string;
  description: string | null;
  icon: string | null;
  sort_order: number | null;
  sort_key: string;
}

/** A file attached to a page */
export interface AssetRow {
  id: string;
  repo_id: string;
  slug_path: string;
  mime: string;
  size_bytes: number;
  content_hash: string;
}

/**
 * A search result from any method
 *
 * snippet is a safe HTML excerpt
 * chunk_ord and chunk_text null in keyword
 * results to keep a single row shape
 */
export interface SearchHit {
  repo_id: string;
  slug_path: string;
  title: string;

  snippet: string;

  chunk_ord: number | null;
  chunk_text: string | null;
  rank: number;

  icon: string | null;
  is_index: boolean;

  html: string;
  repo_namespace: string;
  repo_slug: string;
  forge_key: string;
}

/**
 * A page related by a graph edge
 *
 * fragment is the anchor text for outbound
 * links and empty for inbound links
 */
export interface RelatedRow {
  repo_id: string;
  slug_path: string;
  title: string;
  description: string | null;
  icon: string | null;

  fragment: string;
  repo_namespace: string;
  repo_slug: string;
  forge_key: string;
}

/** A taxonomy term attached to a page */
export interface TermRow {
  term: string;
  label: string;
}

/** A page reference in graph analysis */
export interface GraphPageRow {
  repo_namespace: string;
  repo_slug: string;
  forge_key: string;
  slug_path: string;
  title: string;
}

/**
 * An edge in the page graph
 *
 * detail lists source-only principals for
 * narrowing edges and is empty for dangling
 */
export interface GraphEdgeRow {
  namespace: string;
  slug: string;
  source_slug_path: string;
  target_slug_path: string;

  detail: string;
}

/** Graph analysis for a tenant */
export interface GraphReport {
  edges: number;
  terms: number;
  pages: number;
  most_linked: (GraphPageRow & { inbound: number })[];
  unlinked: GraphPageRow[];
  dangling: GraphEdgeRow[];
  narrowing: GraphEdgeRow[];
}

/** Filters and limits for search queries */
export interface SearchOptions {
  limit?: number;

  repoId?: string;

  pathPrefix?: string;

  retrievalOnly?: boolean;
}
