/**
 * Choose which files of a commit a sync downloads
 *
 * Uses the same cascade as the walk: `sync.include` replaces, `sync.exclude` adds
 * Configs are checked out first, then the included files and the covers the configs name
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import micromatch from 'micromatch';

import { ConfigService } from '../config/config.service';
import type { CommitTree } from '../forge/git';
import { FindingList } from './findings';
import {
  isConfigFilename,
  isMisnamedConfigFilename,
  relativeToIngestRoot,
  resolveRelative,
  slugForDirectory,
} from './paths';
import { validateConfigFile } from './validate';
import { readConfigFile } from './walk/fs';
import { normalizeIngestRoot } from './walk/root';

interface Rules {
  include: string[];
  exclude: string[];
  matches: (path: string) => boolean;
  /** Whether the walk reads this directory's config */
  scanned: boolean;
}

export async function checkoutIncludedFiles(
  tree: CommitTree,
  config: ConfigService,
): Promise<void> {
  await tree.checkout(
    tree.paths.filter(
      (path) => !path.includes('/') && (isConfigFilename(path) || isMisnamedConfigFilename(path)),
    ),
  );
  const rootFile = await readConfigFile(tree.workingTree);
  if (!rootFile) return;
  const root = validateConfigFile(
    rootFile.raw,
    { source: rootFile.name, isRoot: true },
    new FindingList(),
  );
  if (!root) return;
  const ingestRoot = normalizeIngestRoot(root.config.ingest_root ?? '');
  if (ingestRoot.split('/').includes('..')) return;

  await tree.checkout(
    tree.paths.filter(
      (path) =>
        path.includes('/') && isConfigFilename(nameOf(path)) && isScanned(ingestRoot, dirOf(path)),
    ),
  );

  const covers = new Set<string>();
  addCover(covers, '', config.instance.defaults?.display?.cover);
  addCover(covers, '', root.config.display?.cover);

  const rootRules = rulesOf(
    root.config.sync?.include ?? config.syncDefaults.include,
    [...config.syncDefaults.exclude, ...(root.config.sync?.exclude ?? [])],
    true,
  );
  const known = new Map<string, Rules | null>();
  const rulesFor = async (dir: string): Promise<Rules | null> => {
    const cached = known.get(dir);
    if (cached !== undefined) return cached;
    const parent = dir === ingestRoot ? rootRules : await rulesFor(dirOf(dir));
    let rules = parent;
    if (parent?.scanned && dir !== '') {
      rules =
        dir === ingestRoot || isScannedName(nameOf(dir))
          ? await folderRules(dir, parent)
          : { ...parent, scanned: false };
    }
    known.set(dir, rules);
    return rules;
  };

  const folderRules = async (dir: string, parent: Rules): Promise<Rules | null> => {
    const file = await readConfigFile(join(tree.workingTree, dir));
    if (!file) return parent;
    const parsed = validateConfigFile(
      file.raw,
      { source: `${dir}/${file.name}`, isRoot: false, rootVersion: root.config.version },
      new FindingList(),
    );
    if (!parsed) return null;
    addCover(covers, dir, parsed.config.display?.cover);
    return rulesOf(
      parsed.config.sync?.include ?? parent.include,
      [...parent.exclude, ...(parsed.config.sync?.exclude ?? [])],
      true,
    );
  };

  const selected: string[] = [];
  for (const path of tree.paths) {
    const inside = relativeToIngestRoot(ingestRoot, path);
    if (inside === null) continue;
    const rules = await rulesFor(dirOf(path));
    if (!isConfigFilename(nameOf(path)) && rules?.matches(inside)) selected.push(path);
  }
  await tree.checkout([...selected, ...covers]);

  if (ingestRoot && tree.paths.some((path) => path.startsWith(`${ingestRoot}/`))) {
    await fs.mkdir(join(tree.workingTree, ingestRoot), { recursive: true });
  }
}

function rulesOf(include: string[], exclude: string[], scanned: boolean): Rules {
  const included = include.map((pattern) => micromatch.matcher(pattern));
  const excluded = exclude.map((pattern) => micromatch.matcher(pattern));
  return {
    include,
    exclude,
    matches: (path) =>
      included.some((match) => match(path)) && !excluded.some((match) => match(path)),
    scanned,
  };
}

function isScanned(ingestRoot: string, dir: string): boolean {
  const inside = relativeToIngestRoot(ingestRoot, dir);
  return inside !== null && inside.split('/').filter(Boolean).every(isScannedName);
}

function isScannedName(name: string): boolean {
  return !name.startsWith('.') && slugForDirectory(name).slug !== '';
}

function addCover(covers: Set<string>, baseDir: string, cover: string | null | undefined): void {
  if (typeof cover !== 'string') return;
  const path = resolveRelative(baseDir, cover);
  if (path) covers.add(path);
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
