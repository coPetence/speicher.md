/**
 * Resolve `display.cover` references to registered asset paths
 *
 * Both per-folder and root covers go through the same validation pipeline
 * A cover path is resolved relative to its declaring config file, checked
 * to be within the working tree, and registered as an asset
 * Errors are reported only at the level that declared the cover, not where
 * it was inherited
 */

import { InheritedCover } from '../cascade';
import { FindingList } from '../findings';
import { CONFIG_FILENAME, isSvg, resolveRelative } from '../paths';
import { AssetRegistry } from './assets';
import { RepoRoot, ScanState } from './state';

/** Resolve cover for each scanned directory, keyed by directory slug path */
export async function resolveFolderCovers(
  scan: ScanState,
  assets: AssetRegistry,
): Promise<Map<string, string | null>> {
  const covers = new Map<string, string | null>();
  for (const [slugPath, dir] of scan.dirs) {
    covers.set(
      slugPath,
      await resolveCover(
        dir.resolved.cover,
        dir.sourcePath,
        `${dir.sourcePath}/${CONFIG_FILENAME}`,
        assets,
        scan.root.findings,
      ),
    );
  }
  return covers;
}

/** Resolve cover for the repository root */
export async function resolveRepoCover(
  root: RepoRoot,
  assets: AssetRegistry,
): Promise<string | null> {
  return resolveCover(
    root.resolved.cover,
    '',
    CONFIG_FILENAME,
    assets,
    root.findings,
    root.lineOf('display.cover') ?? undefined,
  );
}

/**
 * Resolve a cover reference to a registered asset slug path
 *
 * Reports cover errors only at the declaring level, not inherited
 * Not SVG
 */
async function resolveCover(
  cover: InheritedCover | null | undefined,
  declaringDir: string,
  source: string,
  assets: AssetRegistry,
  findings: FindingList,
  line?: number,
): Promise<string | null> {
  if (cover === undefined || cover === null) return null;

  const repoRelative = resolveRelative(cover.baseDir, cover.path);
  const declaredHere = cover.baseDir === declaringDir;
  if (repoRelative === null || repoRelative === '') {
    if (declaredHere) {
      findings.reject({
        code: 'cover-outside-tree',
        source,
        line,
        message: `display.cover "${cover.path}" resolves outside the repository working tree`,
      });
    }
    return null;
  }

  if (isSvg(repoRelative)) {
    findings.reject({
      code: 'cover-svg',
      source,
      line,
      message: 'display.cover must not be an SVG',
    });
    return null;
  }

  const slugPath = await assets.register(repoRelative, source);
  if (slugPath === null) {
    findings.reject({
      code: 'cover-missing',
      source,
      line,
      message: `display.cover "${cover}" does not exist in the repository`,
    });
    return null;
  }
  return slugPath;
}
