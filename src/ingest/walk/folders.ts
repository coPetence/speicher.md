/**
 * Builds folder metadata for the ingest pipeline
 *
 * Called from walkRepo after directory scanning and page rendering
 * Produces one IngestedFolder per scanned directory
 */

import { deslugify } from '../../common/slug';
import { IngestedDocument, IngestedFolder } from '../ingested';
import { ScanState } from './state';

/**
 * Build IngestedFolder array from the scanned directory tree
 *
 * Title from index doc first, then folder config ownTitle, then deslugified
 * name: page frontmatter is the most specific source
 * Cover from pre-resolved map rather than re-resolved here
 * sortKey lowercased for case-insensitive default ordering
 */
export function buildFolders(
  scan: ScanState,
  documents: IngestedDocument[],
  covers: Map<string, string | null>,
): IngestedFolder[] {
  const folders: IngestedFolder[] = [];
  for (const [slugPath, dir] of scan.dirs) {
    const indexDoc = documents.find((d) => d.isIndex && d.slugPath === slugPath);

    const title =
      indexDoc?.title ??
      dir.resolved.ownTitle ??
      (slugPath === ''
        ? (scan.root.resolved.ownTitle ?? '')
        : deslugify(slugPath.split('/').pop() ?? ''));
    folders.push({
      sourcePath: dir.sourcePath,
      slugPath,
      parentPath: slugPath === '' ? null : slugPath.split('/').slice(0, -1).join('/'),
      title: title || deslugify(slugPath.split('/').pop() ?? 'root'),
      sortOrder: dir.sortOrder,
      sortKey: (title || slugPath).toLowerCase(),
      coverPath: covers.get(slugPath) ?? null,
      icon: indexDoc?.icon ?? null,
      principals: dir.resolved.principals,
      configSource: { chain: dir.resolved.chain, dropped_grants: dir.resolved.droppedGrants },
    });
  }
  return folders;
}
