/**
 * Ingested types after config resolution and rendering
 *
 * Produced by the walk stage
 * Consumed by the write stage for DB persistence
 * Each interface corresponds to one database table
 */

import { ConfigSource } from '../authz/explain';

/** A rendered page ready for storage */
export interface IngestedDocument {
  sourcePath: string;
  slugPath: string;
  parentPath: string;
  title: string;
  description: string | null;
  html: string;
  markdown: string; // Original body with internal links rewritten to slug paths
  plain: string; // Stripped HTML for full-text search
  isIndex: boolean;
  indexable: boolean; // Allowed in search results
  principals: string[]; // Who may read the page
  configSource: ConfigSource; // Config cascade trail, for explain UI
  contentHash: string; // SHA-256 of raw file bytes, for change detection
  sortOrder: number | null;
  sortKey: string; // Lowercased title, for alphabetical fallback sort
  coverPath: string | null;
  icon: string | null; // Lucide icon identifier
  redirectFrom: string[]; // Slug paths that redirect to this page
}

/** A directory with its resolved config */
export interface IngestedFolder {
  sourcePath: string;
  slugPath: string;
  parentPath: string | null; // null for the root folder
  title: string;
  sortOrder: number | null;
  sortKey: string; // Lowercased title, for alphabetical fallback sort
  coverPath: string | null;
  icon: string | null;
  principals: string[]; // Who may read the folder
  configSource: ConfigSource; // Config cascade trail, for explain UI
}

/** A non-markdown file registered during ingestion */
export interface IngestedAsset {
  sourcePath: string;
  slugPath: string;
  parentPath: string;
  mime: string;
  sizeBytes: number;
  contentHash: string;
  principals: string[]; // Who may access the asset

  absolutePath: string; // Filesystem path for blob upload; not persisted
}

/** A directed link from one page to another */
export interface IngestedEdge {
  sourceSlugPath: string;
  kind: 'link'; // Only kind; union type for future expansion
  targetSlugPath: string;

  targetFragment: string; // URL fragment (#anchor) from the link
  ordinal: number; // Position among edges from this source

  targetRepoId: string | null; // null when the target is in the same repo
}

/** A tag drawn from page frontmatter */
export interface IngestedTerm {
  sourceSlugPath: string;
  term: string; // Lowercased, for case-insensitive matching
  label: string; // As written in frontmatter, for display
  ordinal: number; // Position among terms from this source
}
