/**
 * Validate `redirect_from` frontmatter entries and produce redirect records
 *
 * redirect_from values come from frontmatter as site-absolute paths
 * They are stored repo-relative so a repo rename cannot invalidate them
 * Collisions with a live path or duplicate claims are warned and ignored
 */

import { FindingList } from './findings';
import { IngestedDocument } from './ingested';

/** A path that should redirect to another path */
export interface Redirect {
  from: string;
  to: string;
}

/** Identifies which repo within a forge the redirect paths belong to */
export interface RedirectScope {
  namespace: string;
  slug: string;
  forgeKey: string;
}

/**
 * Collect validated redirects from documents' redirect_from entries
 *
 * Each entry must be site-absolute, within this repo, not collide with a live
 * path, nor be claimed more than once
 */
export function collectRedirects(
  scope: RedirectScope,
  documents: IngestedDocument[],
  findings: FindingList,
): Redirect[] {
  const livePaths = new Set(documents.map((d) => d.slugPath));
  const out: Redirect[] = [];
  const claimed = new Set<string>();

  for (const doc of documents) {
    for (const raw of doc.redirectFrom) {
      if (!raw.startsWith('/')) {
        findings.warn({
          code: 'redirect-invalid',
          source: doc.sourcePath,
          message: `redirect_from "${raw}" must be a site-absolute path starting with "/"`,
        });
        continue;
      }

      const withinRepo = stripRepoPrefix(raw, scope);
      if (withinRepo === null) {
        // Not under this repo's slug prefix
        findings.warn({
          code: 'redirect-invalid',
          source: doc.sourcePath,
          message:
            `redirect_from "${raw}" is not a path within this repo. ` +
            `Expected something under "/${scope.slug}/" or "/${scope.namespace}/${scope.slug}/".`,
        });
        continue;
      }
      if (livePaths.has(withinRepo)) {
        // Would shadow an existing page
        findings.warn({
          code: 'redirect-invalid',
          source: doc.sourcePath,
          message: `redirect_from "${raw}" collides with a live path and was ignored`,
        });
        continue;
      }
      if (claimed.has(withinRepo)) {
        findings.warn({
          code: 'redirect-invalid',
          source: doc.sourcePath,
          message: `redirect_from "${raw}" is claimed by more than one page and was ignored`,
        });
        continue;
      }
      claimed.add(withinRepo);
      out.push({ from: withinRepo, to: doc.slugPath });
    }
  }
  return out;
}

/**
 * Strip the repo slug prefix from a site-absolute path
 *
 * Only the `/[slug]/` pattern is checked; the `/[namespace]/[slug]/` pattern
 * in the error message is not implemented
 */
function stripRepoPrefix(raw: string, { namespace, slug, forgeKey }: RedirectScope): string | null {
  const segments = raw.split('/').filter(Boolean);
  if (segments.some((s) => s === '.' || s === '..')) return null;
  // Rejects relative parent/self references

  const prefixes = [
    [slug], // default namespace on the primary forge
    [namespace, slug], // named namespace on the primary forge
    [forgeKey, namespace, slug], // a non-primary forge
  ];
  for (const prefix of prefixes) {
    if (segments.length > prefix.length && prefix.every((part, i) => segments[i] === part)) {
      return segments.slice(prefix.length).join('/');
    }
  }
  return null;
}
