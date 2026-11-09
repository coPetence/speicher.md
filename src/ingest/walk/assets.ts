/**
 * Asset file registration and resolution
 *
 * Links to non-markdown files use a placeholder during markdown rendering
 * The synchronous callback cannot perform async filesystem checks
 * register() validates each asset after rendering and replaces the placeholder
 *
 * register() enforces the max asset size limit and prevents path traversal
 * via symlink resolution
 *
 * All files that are referenced by pages are registered, even if they do not match `sync.include`
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';

import micromatch from 'micromatch';

import type { CommitTree } from '../../forge/git';
import { ResolvedConfig } from '../cascade';
import { IngestedAsset } from '../ingested';
import {
  REPO_BASE_SENTINEL,
  mimeForPath,
  relativeToIngestRoot,
  slugAssetPath,
  slugForDirectory,
} from '../paths';
import { isInside, realPathOrNull } from './fs';
import { ScanState } from './state';

/**
 * Tracks asset files and resolves their slug paths
 *
 * Maps repo-relative paths to IngestedAsset records
 * The owning directory's resolved config provides the asset's principals
 * Two-phase: pendingAsset placeholder during rendering, register() after
 */
export class AssetRegistry {
  private readonly assets = new Map<string, IngestedAsset>();

  constructor(
    private readonly scan: ScanState,
    private readonly commit?: CommitTree,
  ) {}

  /** Registered assets as an array */
  collected(): IngestedAsset[] {
    return [...this.assets.values()];
  }

  /** Slug path for a registered asset, or null */
  slugFor(repoRelativePath: string): string | null {
    return this.assets.get(repoRelativePath)?.slugPath ?? null;
  }

  /**
   * Downloads the linked files that are not in the working tree yet
   */
  async fetchLinked(repoRelativePaths: string[]): Promise<void> {
    if (!this.commit) return;
    const { workingTree, ingestRoot } = this.scan.root;
    const inCommit = new Set(this.commit.paths);
    const wanted: string[] = [];
    for (const path of new Set(repoRelativePaths)) {
      if (!inCommit.has(path)) continue;
      if ((await fs.lstat(resolve(workingTree, path)).catch(() => null)) !== null) continue;
      const owning = resolvedForRepoDir(this.scan, dirOf(path));
      if (owning === null) continue;
      const inside = relativeToIngestRoot(ingestRoot, path);
      if (inside !== null && micromatch.isMatch(inside, owning.exclude)) continue;
      wanted.push(path);
    }
    await this.commit.checkout(wanted);
  }

  /**
   * Validates and registers an asset file
   *
   * Verifies the file is inside the working tree and under the size limit
   * Realpath check prevents path traversal via symlink
   * Returns the slug path, or null and a warning if invalid
   */
  async register(repoRelativePath: string, referencedFrom: string): Promise<string | null> {
    const existing = this.assets.get(repoRelativePath);
    if (existing) return existing.slugPath;

    const { workingTree, ingestRoot, findings, maxAssetBytes } = this.scan.root;

    const owning = resolvedForRepoDir(this.scan, dirOf(repoRelativePath));
    if (owning === null) return null;

    const absolute = resolve(workingTree, repoRelativePath);

    if (!isInside(workingTree, absolute)) return null;
    const real = await realPathOrNull(absolute);
    if (real === null || !isInside(await fs.realpath(workingTree), real)) return null;

    const stat = await fs.stat(real).catch(() => null);
    if (!stat?.isFile()) return null;

    if (stat.size > maxAssetBytes) {
      findings.warn({
        code: 'asset-too-large',
        source: referencedFrom,
        message: `asset "${repoRelativePath}" is ${stat.size} bytes, over max_asset_bytes (${maxAssetBytes})`,
      });
      return null;
    }

    const bytes = await fs.readFile(real);
    const slugPath = assetSlugPath(repoRelativePath, ingestRoot);
    const asset: IngestedAsset = {
      sourcePath: repoRelativePath,
      slugPath,
      parentPath: slugPath.split('/').slice(0, -1).join('/'),
      mime: mimeForPath(repoRelativePath),
      sizeBytes: stat.size,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      principals: owning.principals,
      absolutePath: real,
    };
    this.assets.set(repoRelativePath, asset);
    return slugPath;
  }
}

const PENDING_PREFIX = '/~asset~/'; // Sentinel prefix; replaced by replacePendingAsset

/** Placeholder URL using the sentinel prefix, replaced after registration */
export function pendingAsset(repoRelative: string, suffix: string): string {
  return `${PENDING_PREFIX}${encodeURIComponent(repoRelative)}${suffix}`;
}

/** Finds all pending asset placeholder paths in rendered HTML */
export function collectPendingAssets(html: string): string[] {
  const found = new Set<string>();
  // Matches PENDING_PREFIX then captures the repo-relative path (Group 1)
  // Path is delimited by quote, whitespace, #, or ? to avoid matching suffixes
  const pattern = new RegExp(`${PENDING_PREFIX.replace(/[/~]/g, '\\$&')}([^"'\\s#?]+)`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) found.add(decodeURIComponent(match[1]));
  return [...found];
}

/** Replaces a pending placeholder with the resolved slug path, or #broken-asset */
export function replacePendingAsset(
  html: string,
  repoRelative: string,
  slugPath: string | null,
): string {
  const needle = `${PENDING_PREFIX}${encodeURIComponent(repoRelative)}`;
  const replacement = slugPath === null ? '#broken-asset' : `${REPO_BASE_SENTINEL}/${slugPath}`;
  return html.split(needle).join(replacement);
}

/** Slug path for an asset, prefixed with _repo/ if outside the ingest root */
function assetSlugPath(repoRelativePath: string, ingestRoot: string): string {
  const inside = relativeToIngestRoot(ingestRoot, repoRelativePath);
  return inside === null ? `_repo/${slugAssetPath(repoRelativePath)}` : slugAssetPath(inside);
}

function resolvedForRepoDir(scan: ScanState, repoRelativeDir: string): ResolvedConfig | null {
  const inside = relativeToIngestRoot(scan.root.ingestRoot, repoRelativeDir);
  if (inside === null) return scan.root.resolved;
  const slugs = inside
    .split('/')
    .filter(Boolean)
    .map((part) => slugForDirectory(part).slug);
  for (let depth = slugs.length; depth > 0; depth--) {
    const slugPath = slugs.slice(0, depth).join('/');
    if (scan.failedSubtrees.includes(slugPath)) return null;
    const dir = scan.dirs.get(slugPath);
    if (dir) return dir.resolved;
  }
  return scan.root.resolved;
}

function dirOf(repoRelativePath: string): string {
  return repoRelativePath.split('/').slice(0, -1).join('/');
}
