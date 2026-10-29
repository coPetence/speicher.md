/**
 * Whether a repository is ready to be published, from its `.speicher.yaml` files as they are on GitHub
 *
 * The same validator the sync uses reads them, so the check and the sync that
 * follows cannot disagree: a repository without a root file is not published,
 * one whose files are refused is not synced, and a group none of the instance's
 * groups is called is a grant that reaches nobody
 */

import { PUBLIC_GROUP_NAME } from '../../../common/principals';
import { normalizeAccess } from '../../../config/types';
import { FindingList } from '../../../ingest/findings';
import { validateConfigFile } from '../../../ingest/validate';

/** A `.speicher.yaml` or `.speicher.yml`, by its path in the repository */
export interface ConfigFile {
  path: string;
  raw: string;
}

/** The instance's groups, as the check asks about them */
export interface KnownGroups {
  hasGroup(name: string): boolean;
  suggestGroup(name: string): string | null;
}

export interface UnknownGroup {
  name: string;
  // A group of the instance the name is close to, e.g. a typo of it
  suggestion: string | null;
  // The files that name it
  files: string[];
}

export type RepositoryVerdict =
  // No root file: the repository is not published, which is not an error
  | { state: 'unpublished' }
  // A file the sync would refuse, with why
  | { state: 'invalid'; file: string; message: string }
  // Published, but some of the groups it grants to do not exist
  | { state: 'unknown-groups'; groups: UnknownGroup[]; readers: string[] }
  // Published to these readers, all of them known
  | { state: 'ready'; readers: string[] };

const ROOT_FILES = ['.speicher.yaml', '.speicher.yml'];

/** Whether a path names a `.speicher.yaml` or `.speicher.yml`, at the root or in a folder */
export function isConfigPath(path: string): boolean {
  return /(^|\/)\.speicher\.ya?ml$/.test(path);
}

/**
 * checkRepository says whether a repository is ready to be published.
 *
 * @param files the repository's `.speicher.yaml` files
 * @param known the instance's groups
 */
export function checkRepository(files: ConfigFile[], known: KnownGroups): RepositoryVerdict {
  const root = files.find((file) => ROOT_FILES.includes(file.path));
  if (!root) return { state: 'unpublished' };

  const named = new Map<string, string[]>();
  let readers: string[] = [];
  // The root first: a folder's file is validated against the root's version
  const ordered = [root, ...files.filter((file) => file !== root)];
  let rootVersion: number | undefined;
  for (const file of ordered) {
    const isRoot = file === root;
    const findings = new FindingList();
    const parsed = validateConfigFile(
      file.raw,
      { source: file.path, isRoot, rootVersion },
      findings,
    );
    const refused = findings.rejections[0];
    if (!parsed || refused) {
      return {
        state: 'invalid',
        file: file.path,
        message: refused?.message ?? 'The file could not be read.',
      };
    }

    const access = normalizeAccess(parsed.config.access);
    if (isRoot) {
      rootVersion = parsed.config.version;
      if (!access) {
        return {
          state: 'invalid',
          file: file.path,
          message: 'It has no `access` block, so nobody may read the repository.',
        };
      }
      readers = [...(access.groups ?? [])];
      const people = access.users?.length ?? 0;
      if (people > 0) readers.push(people === 1 ? '1 person' : `${people} people`);
    }
    for (const name of [...(access?.groups ?? []), ...(parsed.config.maintainers?.groups ?? [])]) {
      if (name === PUBLIC_GROUP_NAME || known.hasGroup(name)) continue;
      named.set(name, [...(named.get(name) ?? []), file.path]);
    }
  }

  if (named.size === 0) return { state: 'ready', readers };
  return {
    state: 'unknown-groups',
    readers,
    groups: [...named].map(([name, paths]) => ({
      name,
      suggestion: known.suggestGroup(name),
      files: [...new Set(paths)],
    })),
  };
}

/** A group the repositories of a source grant access to that the instance does not have */
export interface MissingGroup {
  name: string;
  suggestion: string | null;
  // The repositories that name it, e.g. `acme/handbook`
  repositories: string[];
}

/**
 * missingGroups gathers the groups the checked repositories name and the instance does not have, each once.
 *
 * @param checked each repository with what the check found in it
 */
export function missingGroups(
  checked: { repository: string; verdict: RepositoryVerdict | null }[],
): MissingGroup[] {
  const missing = new Map<string, MissingGroup>();
  for (const { repository, verdict } of checked) {
    if (verdict?.state !== 'unknown-groups') continue;
    for (const group of verdict.groups) {
      const known = missing.get(group.name);
      if (known) known.repositories.push(repository);
      else {
        missing.set(group.name, {
          name: group.name,
          suggestion: group.suggestion,
          repositories: [repository],
        });
      }
    }
  }
  return [...missing.values()];
}

/**
 * starterConfig returns the `.speicher.yaml` the check offers to create in a repository that has none.
 *
 * @param group a group of the instance to grant reading to, or null to name one that is still to be created
 */
export function starterConfig(group: string | null): string {
  return [
    'version: 1',
    '',
    '# Who may read this repository. Every name is a group of your Speicher.md instance',
    'access:',
    `  groups: [${group ?? 'readers'}]`,
    '',
  ].join('\n');
}
