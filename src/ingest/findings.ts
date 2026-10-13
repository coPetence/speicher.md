/**
 * Validation findings reported during content ingestion
 *
 * Each finding records a problem at a source location with a machine-readable
 * code and a human-readable message
 * Severity controls sync behaviour: reject blocks the sync, warn reports
 * without blocking, info records silently
 *
 * FindingCode is the union of all known finding types
 * FindingList accumulates findings and provides query and formatting helpers
 */

export type Severity = 'reject' | 'warn' | 'info';

/** A problem discovered during content ingestion, with context for the author and admin */
export interface Finding {
  severity: Severity;

  source: string;

  line?: number;

  message: string;

  adminMessage?: string; // Admin-facing detail such as principal names or candidate lists

  code: FindingCode;

  suggestion?: string; // Suggested replacement for the invalid value
}

/** Known finding codes, one per class of problem */
export type FindingCode =
  | 'yaml-malformed'
  | 'schema-invalid'
  | 'unknown-key'
  | 'unknown-group'
  | 'unknown-provider'
  | 'ambiguous-provider'
  | 'version-mismatch'
  | 'version-in-folder'
  | 'root-key-in-folder'
  | 'interpolation-forbidden'
  | 'access-missing'
  | 'access-in-frontmatter'
  | 'cover-missing'
  | 'cover-outside-tree'
  | 'cover-svg'
  | 'slug-collision'
  | 'mixed-ordering'
  | 'duplicate-config'
  | 'empty-read-set'
  | 'noop-narrowing'
  | 'public-not-enabled'
  | 'public-not-a-maintainer'
  | 'public-narrowed-away'
  | 'grant-expired'
  | 'grant-expiring'
  | 'grant-unresolved'
  | 'directory-unavailable'
  | 'grant-missing-note'
  | 'grant-missing-until'
  | 'redirect-invalid'
  | 'broken-link'
  | 'link-narrower-target'
  | 'cross-repo-unresolved'
  | 'cross-repo-asset'
  | 'wikilink-embed'
  | 'ambiguous-wikilink'
  | 'mdx-component'
  | 'mdx-expression'
  | 'unknown-icon'
  | 'asset-too-large'
  | 'content-branch-reserved'
  | 'reserved-segment';

/** Accumulates findings during ingestion and provides query and formatting helpers */
export class FindingList {
  private readonly items: Finding[] = [];

  add(finding: Finding): void {
    this.items.push(finding);
  }

  reject(f: Omit<Finding, 'severity'>): void {
    this.add({ ...f, severity: 'reject' });
  }
  warn(f: Omit<Finding, 'severity'>): void {
    this.add({ ...f, severity: 'warn' });
  }
  info(f: Omit<Finding, 'severity'>): void {
    this.add({ ...f, severity: 'info' });
  }

  /** All findings; returns a copy so the caller cannot mutate the internal list */
  get all(): Finding[] {
    return [...this.items];
  }

  get rejections(): Finding[] {
    return this.items.filter((f) => f.severity === 'reject');
  }

  /** Rejections whose source is the prefix or a path inside it */
  rejectionsUnder(prefix: string): Finding[] {
    return this.rejections.filter(
      (f) => prefix === '' || f.source === prefix || f.source.startsWith(prefix + '/'),
    );
  }

  get hasRejection(): boolean {
    return this.items.some((f) => f.severity === 'reject');
  }

  merge(other: FindingList): void {
    this.items.push(...other.all);
  }

  /** Lines for the author: source (and optional line), message, and a suggestion hint */
  toAuthorText(): string {
    return this.items
      .filter((f) => f.severity !== 'info')
      .map((f) => {
        const where = f.line ? `${f.source}:${f.line}` : f.source;
        const hint = f.suggestion ? `\n                 did you mean "${f.suggestion}"?` : '';
        return `  ${where}  ${f.message}${hint}`;
      })
      .join('\n');
  }
}
