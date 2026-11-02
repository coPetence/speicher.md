import { slugify } from '../../common/slug';
import type { CheckRow } from '../configurator/config-page/payloads';
import type { RepoStatus } from '../status/status.types';
import type { Level } from '../ui/levels';

export interface RepositoryCell {
  level: Level;
  label: string;
}

export interface RepositoryTableRow {
  // The name in lower case, as the sync keeps it, which a row is found by
  key: string;
  // e.g. `acme/Handbook`, as GitHub spells it once a check has found it
  name: string;
  // The repository on GitHub, once a check has found it
  href: string | null;
  // Its page on the sync status, once a sync has found it
  status_href: string | null;
  synced: { namespace: string; slug: string } | null;
  // The short id of its content source
  source: string | null;
  // The modal that creates its `.speicher.yaml`, GitHub's page that edits it, or whether the file to commit is copied
  file: RepositoryCell & {
    create_href?: string;
    create_action?: string;
    edit_href?: string;
    copy?: boolean;
    misnamed?: string;
  };
  // Who its `.speicher.yaml` lets read it, or what keeps it from doing so, in markdown, once a check has read the file
  access: { level: Level; text: string } | null;
  // The groups its `.speicher.yaml` lets read it, once a check has read the file
  groups: string[] | null;
  // As on the sync status page
  sync: Pick<RepoStatus, 'state' | 'activity' | 'last_error'>;
  readable: boolean;
}

/**
 * repositoryTable returns the rows of the repository step, by name.
 *
 * @param status the repositories as the sync status has them
 * @param readable the names of the repositories the administrator can read a page of
 * @param checks what the checks of GitHub sources found, by source
 * @param copies the sources whose repositories are given the file to commit
 */
export function repositoryTable(
  status: RepoStatus[],
  readable: string[],
  checks: Map<string, CheckRow[]>,
  copies: Set<string>,
): RepositoryTableRow[] {
  const reads = new Set(readable.map(repositoryKey));
  const rows = new Map<string, RepositoryTableRow>();
  for (const repo of status) {
    const name = `${repo.namespace}/${repo.slug}`;
    const key = repositoryKey(name);
    rows.set(key, {
      key,
      name,
      href: null,
      status_href: `/-/status/${encodeURIComponent(repo.namespace)}/${encodeURIComponent(repo.slug)}`,
      synced: { namespace: repo.namespace, slug: repo.slug },
      source: repo.forge_key,
      file: syncedFile(repo, copies),
      access: null,
      groups: null,
      sync: { state: repo.state, activity: repo.activity, last_error: repo.last_error },
      readable: reads.has(key),
    });
  }
  for (const [source, found] of checks) {
    for (const check of found) {
      const key = repositoryKey(check.name);
      const file = checkedFile(check);
      const access = checkedAccess(check);
      const row = rows.get(key) ?? {
        key,
        name: check.name,
        href: null,
        status_href: null,
        synced: null,
        source,
        file,
        access,
        groups: null,
        // Not found by a sync yet: published with its first sync, or not at all without a file
        sync: {
          state: check.state === 'unpublished' ? 'unpublished' : 'never-synced',
          activity: null,
          last_error: null,
        },
        readable: false,
      };
      rows.set(key, {
        ...row,
        name: check.name,
        href: check.href,
        file,
        access,
        groups: check.groups ?? null,
      });
    }
  }
  return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * repositoryKey returns the key a row is found by: the owner in lower case and the name as the sync slugs it, so
 * `acme/Handbook.md` on GitHub and `acme/handbook-md` in the sync are one row.
 *
 * @param name the repository, as GitHub or the sync names it
 */
export function repositoryKey(name: string): string {
  const cut = name.indexOf('/');
  return `${name.slice(0, cut).toLowerCase()}/${slugify(name.slice(cut + 1))}`;
}

/**
 * repositoryMatchText returns the text the filter box finds a row by: its name and its source, in lower case.
 *
 * @param row the row
 */
export function repositoryMatchText(row: RepositoryTableRow): string {
  return `${row.key} ${row.source ?? ''}`.toLowerCase();
}

// What the sync knows of a repository's `.speicher.yaml`: none once a sync found none, nothing before the first
function syncedFile(repo: RepoStatus, copies: Set<string>): RepositoryTableRow['file'] {
  if (repo.state === 'unpublished') {
    return {
      level: 'idle',
      label: 'missing',
      copy: repo.forge_key !== null && copies.has(repo.forge_key),
    };
  }
  if (repo.state === 'never-synced') return { level: 'idle', label: 'not checked yet' };
  return { level: 'ok', label: 'present' };
}

function checkedFile(check: CheckRow): RepositoryTableRow['file'] {
  const edit = check.edit_href ? { edit_href: check.edit_href } : {};
  switch (check.state) {
    case 'ready':
      return { level: 'ok', label: 'present', ...edit };
    case 'unpublished':
      if (check.misnamed)
        return { level: 'warn', label: 'misnamed', misnamed: check.misnamed, ...edit };
      return {
        level: 'idle',
        label: 'missing',
        create_href: check.create_href,
        create_action: check.create_action,
      };
    case 'unknown-groups':
      return { level: 'warn', label: 'missing group', ...edit };
    case 'invalid':
      return { level: 'fail', label: 'invalid', ...edit };
    case 'unreadable':
      return { level: 'idle', label: 'unknown' };
  }
}

function checkedAccess(check: CheckRow): RepositoryTableRow['access'] {
  switch (check.state) {
    case 'ready':
      return { level: 'ok', text: check.readers ?? '' };
    case 'unpublished':
      return null;
    case 'unknown-groups':
      return { level: 'warn', text: check.text };
    case 'invalid':
      return { level: 'fail', text: check.text };
    case 'unreadable':
      return { level: 'idle', text: check.text };
  }
}
