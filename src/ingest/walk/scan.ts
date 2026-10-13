/**
 * Filesystem scan of the ingest tree
 *
 * Resolves `.speicher.yaml` (or `.speicher.yml`) config inheritance at each directory level
 * Finds markdown files, parses frontmatter, assigns slug paths
 * Index files and sibling-matching files become folder landing pages
 * Slug collisions within a directory are rejected
 * Config parse failure skips the subtree; content parse failure aborts it
 */

import { Dirent, promises as fs } from 'node:fs';
import { join, relative, sep } from 'node:path';

import micromatch from 'micromatch';

import { deslugify } from '../../common/slug';
import { ResolvedConfig, fold, inheritInto } from '../cascade';
import {
  CONFIG_FILENAMES,
  INDEX_FILENAMES,
  isConfigFilename,
  isMarkdown,
  relativeToIngestRoot,
  slugForContentFile,
  slugForDirectory,
} from '../paths';
import { parseContentFile, validateConfigFile } from '../validate';
import { readConfigFile, readFileOrNull, warnIgnoredConfigs } from './fs';
import { RepoRoot, ScanState } from './state';

/** Start a scan from the repo's ingest root */
export async function scanRepo(root: RepoRoot): Promise<ScanState> {
  const scan: ScanState = {
    root,
    dirs: new Map(),
    files: [],
    failedSubtrees: [],
    nextExpiry: root.resolved.nextExpiry,
  };
  await scanDirectory(scan, root.ingestAbs, '', root.resolved, null);
  return scan;
}

/** Per-directory state during a scan pass */
interface DirectoryScan {
  slugPath: string;
  repoRelativeDir: string;
  resolved: ResolvedConfig;
  claimed: Map<string, string>;
  directorySlugs: Map<string, string>;
}

/**
 * Recursively scan a directory
 *
 * Directories first: must complete before sibling collision checks
 * Config failure skips subtree; content failure aborts it
 */
async function scanDirectory(
  scan: ScanState,
  absolute: string,
  slugPath: string,
  inherited: ResolvedConfig,
  sortOrder: number | null,
): Promise<void> {
  const repoRelativeDir = relative(scan.root.workingTree, absolute).split(sep).join('/');

  const directoryConfig = await resolveDirectoryConfig(
    scan,
    absolute,
    repoRelativeDir,
    slugPath,
    inherited,
  );
  if (directoryConfig === null) return;
  const { resolved, configSource } = directoryConfig;

  scan.nextExpiry = minDate(scan.nextExpiry, resolved.nextExpiry);
  scan.dirs.set(slugPath, { sourcePath: repoRelativeDir, configSource, resolved, sortOrder });

  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const dir: DirectoryScan = {
    slugPath,
    repoRelativeDir,
    resolved,
    claimed: new Map(),
    directorySlugs: directorySlugsIn(entries),
  };

  for (const entry of directoriesFirst(entries)) {
    if (isConfigFilename(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    const entryAbs = join(absolute, entry.name);
    const entryRel = repoRelativeDir ? `${repoRelativeDir}/${entry.name}` : entry.name;

    if (entry.isSymbolicLink()) {
      scan.root.findings.warn({
        code: 'schema-invalid',
        source: entryRel,
        message: 'symlinks are not followed',
      });
      continue;
    }

    if (entry.isDirectory()) {
      const { order, slug } = slugForDirectory(entry.name);
      if (!slug) continue;
      if (!claimSlug(scan, dir, slug, entryRel)) continue;
      const childSlugPath = slugPath ? `${slugPath}/${slug}` : slug;
      await scanDirectory(scan, entryAbs, childSlugPath, resolved, order);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!isMarkdown(entry.name)) continue;
    if ((await scanContentFile(scan, dir, entry.name, entryAbs, entryRel)) === 'abort') return;
  }
}

/**
 * Resolve config for a directory from `.speicher.yaml` (or `.speicher.yml`)
 * Not read when already folded (root with empty ingestRoot)
 * No file: inherit parent settings, strip own title
 * Null return: subtree excluded by invalid or rejected config
 */
async function resolveDirectoryConfig(
  scan: ScanState,
  absolute: string,
  repoRelativeDir: string,
  slugPath: string,
  inherited: ResolvedConfig,
): Promise<{ resolved: ResolvedConfig; configSource: string } | null> {
  const alreadyFolded = slugPath === '' && scan.root.ingestRoot === '';
  // Config already loaded by loadRoot; do not fold again
  const configFile = alreadyFolded ? null : await readConfigFile(absolute);
  // No config: inherit parent settings but strip ownTitle so the directory
  // does not display the parent's title
  if (configFile === null) {
    const configName = alreadyFolded ? scan.root.configName : CONFIG_FILENAMES[0];
    return { resolved: inheritInto(inherited), configSource: `${repoRelativeDir}/${configName}` };
  }

  warnIgnoredConfigs(scan.root.findings, configFile, repoRelativeDir);
  const source = `${repoRelativeDir}/${configFile.name}`;
  const parsed = validateConfigFile(
    configFile.raw,
    { source, isRoot: false, rootVersion: scan.root.rootConfig.version },
    scan.root.findings,
  );
  if (!parsed) {
    scan.failedSubtrees.push(slugPath);
    return null;
  }

  const resolved = await fold(
    inherited,
    parsed.config,
    {
      isRoot: false,
      source,
      baseDir: repoRelativeDir,
      lineOf: parsed.lineOf,
      grantContext: scan.root.grantContext,
    },
    scan.root.findings,
  );

  if (scan.root.findings.rejectionsUnder(source).length > 0) {
    scan.failedSubtrees.push(slugPath);
    return null;
  }
  return { resolved, configSource: source };
}

/**
 * Filter and process one markdown file
 * Include/exclude, frontmatter, draft checks
 * Index or sibling-match becomes folder landing page
 * Frontmatter failure returns 'abort'
 */
async function scanContentFile(
  scan: ScanState,
  dir: DirectoryScan,
  name: string,
  entryAbs: string,
  entryRel: string,
): Promise<'next' | 'abort'> {
  const ingestRelative = relativeToIngestRoot(scan.root.ingestRoot, entryRel);
  if (ingestRelative === null) return 'next';
  if (!micromatch.isMatch(ingestRelative, dir.resolved.include)) return 'next';
  if (micromatch.isMatch(ingestRelative, dir.resolved.exclude)) return 'next';

  const raw = await readFileOrNull(entryAbs);
  if (raw === null) return 'next';

  const parsed = parseContentFile(raw, entryRel, scan.root.findings);
  if (!parsed) {
    scan.failedSubtrees.push(dir.slugPath);
    return 'abort';
  }
  if (parsed.frontmatter.draft === true) return 'next';

  if (INDEX_FILENAMES.includes(name.toLowerCase())) {
    scan.files.push({
      sourcePath: entryRel,
      slugPath: dir.slugPath,
      parentPath: dir.slugPath,
      isIndex: true,
      sortOrder: null,
      raw,
      body: parsed.body,
      frontmatter: parsed.frontmatter,
      resolved: dir.resolved,
      folderTitle: deslugify(dir.slugPath.split('/').pop() ?? ''),
    });
    return 'next';
  }

  const { order, slug } = slugForContentFile(name);
  if (!slug) return 'next';
  if (slug === 'index') {
    scan.root.findings.warn({
      code: 'slug-collision',
      source: entryRel,
      message: '`index` is reserved for the folder landing page and cannot be a sibling slug',
    });
    return 'next';
  }

  // File's slug matches a sibling directory: it becomes that directory's landing page
  const siblingDirectory = dir.directorySlugs.get(slug);
  if (siblingDirectory !== undefined) {
    const folderSlugPath = dir.slugPath ? `${dir.slugPath}/${slug}` : slug;
    const folder = scan.dirs.get(folderSlugPath);
    if (!folder) return 'next';

    if (scan.files.some((f) => f.isIndex && f.slugPath === folderSlugPath)) {
      scan.root.findings.reject({
        code: 'slug-collision',
        source: entryRel,
        message:
          `both "${name}" and "${siblingDirectory}/index.md" claim the landing page ` +
          `for "${slug}" — keep one of them`,
      });
      scan.failedSubtrees.push(folderSlugPath);
      return 'next';
    }

    scan.files.push({
      sourcePath: entryRel,
      slugPath: folderSlugPath,
      parentPath: folderSlugPath,
      isIndex: true,
      sortOrder: null,
      raw,
      body: parsed.body,
      frontmatter: parsed.frontmatter,
      resolved: folder.resolved,
      folderTitle: deslugify(slug),
    });
    return 'next';
  }

  if (!claimSlug(scan, dir, slug, entryRel)) return 'next';

  scan.files.push({
    sourcePath: entryRel,
    slugPath: dir.slugPath ? `${dir.slugPath}/${slug}` : slug,
    parentPath: dir.slugPath,
    isIndex: false,
    sortOrder: order,
    raw,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
    resolved: dir.resolved,
    folderTitle: '',
  });
  return 'next';
}

/** Register a slug for an entry, rejecting duplicates in the same directory */
function claimSlug(scan: ScanState, dir: DirectoryScan, slug: string, owner: string): boolean {
  const existing = dir.claimed.get(slug);
  if (existing) {
    scan.root.findings.reject({
      code: 'slug-collision',
      source: owner,
      message: `slug "${slug}" is already claimed by "${existing}" in the same directory`,
    });
    return false;
  }
  dir.claimed.set(slug, owner);
  return true;
}

/** Map subdirectory names to their slugs, for collision detection */
function directorySlugsIn(entries: Dirent[]): Map<string, string> {
  const slugs = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const { slug } = slugForDirectory(entry.name);
    if (slug) slugs.set(slug, entry.name);
  }
  return slugs;
}

/** Sort entries with directories first, for slug collision ordering */
function directoriesFirst(entries: Dirent[]): Dirent[] {
  const sorted = sortedEntries(entries);
  return [...sorted.filter((e) => e.isDirectory()), ...sorted.filter((e) => !e.isDirectory())];
}

function sortedEntries(entries: Dirent[]): Dirent[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/** Earlier of two nullable dates, null if both are null */
function minDate(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}
