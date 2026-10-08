/**
 * Resolves links during page rendering and builds the edge graph
 *
 * Called by the render pipeline for every link type in a page
 * Accumulates resolution metadata (broken, narrowed, ambiguous, malformed)
 *   for later reporting as findings in link-findings.ts
 * Cross-repo links are validated here; their repo IDs are resolved later by
 *   buildEdges through the RepoLookup
 *
 * Self-links produce a URL directly without recording an edge
 * Non-markdown plain links are treated as assets, resolved after registration
 *   via the two-phase asset pipeline (pendingAsset then replacePendingAsset)
 * The returned URLs carry REPO_BASE_SENTINEL, replaced by withRepoBase at
 *   render output
 */
import { slugify } from '../../common/slug';
import { ConfigService } from '../../config/config.service';
import { IngestedEdge } from '../ingested';
import { RepoAddressPolicy, pageCandidates, parseRepoTarget, repoTargetUrl } from '../links';
import { LinkKind } from '../markdown';
import { REPO_BASE_SENTINEL, isMarkdown, resolveRelative, splitTarget } from '../paths';
import { isEmbeddableFile } from '../wikilinks';
import { pendingAsset } from './assets';
import { RenderContext } from './render';
import { ScannedFile } from './state';

/**
 * Results from resolving all links in a page
 *
 * Used to build edges and report findings
 */
export interface PageLinks {
  broken: string[]; // Targets that could not be resolved
  narrower: Map<string, string[]>; // Targets where the destination has fewer principals
  linked: Map<string, { targetSlugPath: string; targetFragment: string; crossRepoUrl?: string }>;

  badAddress: Map<string, string>; // Malformed cross-repo addresses with explanations
  ambiguous: Map<string, string[]>; // Bare names that matched multiple pages

  embeds: string[]; // Targets embedded via ![[...]]

  crossRepoAssets: string[]; // Cross-repo image targets
}

/** Factory returning a PageLinks with all fields at their initial values */
export function emptyPageLinks(): PageLinks {
  return {
    broken: [],
    narrower: new Map(),
    linked: new Map(),
    badAddress: new Map(),
    ambiguous: new Map(),
    embeds: [],
    crossRepoAssets: [],
  };
}

/**
 * Resolve a single link and produce its rendered URL
 *
 * Returns a URL with REPO_BASE_SENTINEL prefix, or null when the target is
 *   broken
 * Self-links (empty path) return the current page URL without recording an edge
 * Non-markdown plain links are not resolved as pages; they go to pendingAsset
 *   for registration after render
 * Wikilinks and wikiembeds always attempt page resolution, falling back to
 *   by-name matching
 */
export function resolvePageLink(
  ctx: RenderContext,
  file: ScannedFile,
  dir: string,
  links: PageLinks,
  target: string,
  kind: LinkKind,
): string | null {
  const { path, suffix } = splitTarget(target);
  if (path === '') return `${REPO_BASE_SENTINEL}/${file.slugPath}${suffix}`;

  if (path.startsWith('@')) return resolveCrossRepo(ctx, file, links, target, path, suffix, kind);

  const repoRelative = resolveRelative(dir, path);
  if (repoRelative === null) {
    links.broken.push(target);
    return null;
  }

  if (kind === 'wikiembed') links.embeds.push(target);

  if (kind !== 'image' && (isMarkdown(repoRelative) || kind !== 'link')) {
    const destination = resolvePageTarget(ctx, links, dir, path, repoRelative, kind);

    if (!destination) {
      if (kind === 'link' || !isEmbeddableFile(repoRelative)) {
        links.broken.push(target);
        return null;
      }
      return pendingAsset(repoRelative, suffix);
    }

    const losing = file.resolved.principals.filter(
      (p) => !destination.resolved.principals.includes(p),
    );
    if (losing.length > 0) links.narrower.set(target, losing);

    if (destination.slugPath !== file.slugPath) {
      const fragment = suffix.startsWith('#') ? suffix.slice(1) : '';
      if (!links.linked.has(edgeKey(destination.slugPath, fragment))) {
        links.linked.set(edgeKey(destination.slugPath, fragment), {
          targetSlugPath: destination.slugPath,
          targetFragment: fragment,
        });
      }
    }
    return `${REPO_BASE_SENTINEL}/${destination.slugPath}${suffix}`;
  }

  return pendingAsset(repoRelative, suffix);
}

/**
 * Find the ScannedFile for a same-repo link target
 *
 * Tries by source path (exact for plain links, pageCandidates for others),
 *   then from repo root, then by name
 * By-name lookup only for paths without directory separators
 */
function resolvePageTarget(
  ctx: RenderContext,
  links: PageLinks,
  dir: string,
  path: string,
  repoRelative: string,
  kind: LinkKind,
): ScannedFile | null {
  const byPath = (base: string | null): ScannedFile | null => {
    if (base === null) return null;
    for (const candidate of kind === 'link' ? [base] : pageCandidates(base)) {
      const found = ctx.bySourcePath.get(candidate);
      if (found) return found;
    }
    return null;
  };

  const relative = byPath(repoRelative);
  if (relative) return relative;
  if (kind === 'link') return null;

  if (dir !== '' && !path.startsWith('/')) {
    const fromRoot = byPath(resolveRelative('', path));
    if (fromRoot) return fromRoot;
  }

  if (path.includes('/')) return null;
  const named = ctx.byName.get(path.toLowerCase()) ?? ctx.byName.get(slugify(path)) ?? [];
  if (named.length === 0) return null;
  if (named.length > 1)
    links.ambiguous.set(
      path,
      named.map((f) => f.sourcePath),
    );
  return named[0];
}

/**
 * Resolve an @-prefixed cross-repo link
 *
 * Validates the address format and produces a URL via repoTargetUrl
 * Cross-repo images are collected into crossRepoAssets without resolution
 * When the resolved URL matches the current repo, returns it directly without
 *   recording an edge
 * Malformed or unresolvable addresses are recorded in badAddress with reasons
 */
function resolveCrossRepo(
  ctx: RenderContext,
  file: ScannedFile,
  links: PageLinks,
  target: string,
  path: string,
  suffix: string,
  kind: LinkKind,
): string | null {
  if (kind === 'image') {
    links.crossRepoAssets.push(target);
    return null;
  }
  if (kind === 'wikiembed') links.embeds.push(target);

  const parsed = parseRepoTarget(path);
  if (parsed === null || parsed === 'malformed') {
    links.badAddress.set(
      target,
      '"@" introduces a repository address, which is `@slug:path`, ' +
        '`@namespace/slug:path` or `@forge/namespace/slug:path`',
    );
    return null;
  }

  const url = repoTargetUrl(parsed, ctx.policy);
  if (url === null) {
    links.badAddress.set(
      target,
      parsed.namespace === null
        ? 'this instance has no default namespace, so the namespace has to be written out'
        : 'this instance has no forge configured',
    );
    return null;
  }

  const own = repoTargetUrl(
    {
      forgeKey: null,
      namespace: ctx.ownRepo.namespace,
      slug: ctx.ownRepo.slug,
      path: file.slugPath,
    },
    ctx.policy,
  );
  if (url === own) return `${url}${suffix}`;

  const fragment = suffix.startsWith('#') ? suffix.slice(1) : '';
  const key = edgeKey(url, fragment);
  if (!links.linked.has(key)) {
    links.linked.set(key, {
      targetSlugPath: parsed.path,
      targetFragment: fragment,
      crossRepoUrl: url,
    });
  }
  return `${url}${suffix}`;
}

/**
 * Convert the linked map into IngestedEdge objects
 *
 * Cross-repo URLs are resolved through RepoLookup to obtain repo IDs
 * Edges whose cross-repo resolution fails are omitted
 * Ordinals preserve the order links were encountered
 */
export async function buildEdges(
  ctx: RenderContext,
  file: ScannedFile,
  links: PageLinks,
): Promise<IngestedEdge[]> {
  const edges: IngestedEdge[] = [];
  for (const edge of links.linked.values()) {
    if (edge.crossRepoUrl === undefined) {
      edges.push({
        sourceSlugPath: file.slugPath,
        kind: 'link',
        targetSlugPath: edge.targetSlugPath,
        targetFragment: edge.targetFragment,
        targetRepoId: null,
        ordinal: edges.length,
      });
      continue;
    }
    const resolved = await resolveRepoPath(ctx, edge.crossRepoUrl);
    if (resolved === null) continue;
    edges.push({
      sourceSlugPath: file.slugPath,
      kind: 'link',
      targetSlugPath: resolved.slugPath,
      targetFragment: edge.targetFragment,
      targetRepoId: resolved.repoId,
      ordinal: edges.length,
    });
  }
  return edges;
}

/**
 * Resolve a cross-repo URL to a repo ID and slug path
 *
 * Results are cached in ctx.repoIds
 * Returns null when no RepoLookup is configured (ctx.repos undefined)
 */
async function resolveRepoPath(
  ctx: RenderContext,
  url: string,
): Promise<{ repoId: string; slugPath: string } | null> {
  if (ctx.repos === undefined) return null;
  const cached = ctx.repoIds.get(url);
  if (cached !== undefined) return cached;
  const answer = await ctx.repos.resolve(url.split('/').filter(Boolean));
  ctx.repoIds.set(url, answer);
  return answer;
}

/**
 * Build the RepoAddressPolicy from the ConfigService
 *
 * The policy controls namespacing and forging for cross-repo addresses
 * defaultRepositoryOwnerSlug resolves the configured default repository owner for a forge
 */
export function addressPolicy(config: ConfigService): RepoAddressPolicy {
  return {
    primaryForgeId: config.primaryForgeId,
    defaultRepositoryOwnerSlug: (forgeKey) => {
      const name = config.defaultRepositoryOwnerFor(forgeKey);
      return name === undefined ? undefined : slugify(name);
    },
  };
}

/**
 * Create a unique key for deduplicating linked edges
 *
 * Null character is the separator since neither slugPath nor fragment can
 *   contain it
 */
function edgeKey(slugPath: string, fragment: string): string {
  return `${slugPath}\u0000${fragment}`;
}
