import { PUBLIC_GROUP_NAME } from '../../common/principals';
import { slugify } from '../../common/slug';
import { misnamedConfigMessage } from '../../ingest/walk/fs';
import { sourceGroupsPath } from '../configurator/config-page/github-app-manifest';
import { publicRepoRef } from '../configurator/quick-setup/repository-check';
import type { SourceCheck } from '../configurator/quick-setup/source-check';
import type { RepositoryTableRow } from './repository-table';

export interface RepositoryFix {
  id:
    | 'administrator'
    | 'group'
    | 'source'
    | 'checking'
    | 'install'
    | 'check-failed'
    | 'no-repository'
    | 'create-repository'
    | 'discovering'
    | 'discover'
    | 'add-repository'
    | 'not-found'
    | 'misnamed'
    | 'no-file'
    | 'invalid'
    | 'missing-group'
    | 'no-grant'
    | 'public'
    | 'sync-failed'
    | 'syncing'
    | 'no-page'
    | 'no-readable-page';
  waits: boolean;
  title: string;
  text?: string;
  detail?: string;
  action?: FixAction;
  secondary?: FixAction;
  snippet?: boolean;
}

export interface FixAction {
  label: string;
  href: string;
  external?: boolean;
  create?: { action: string; repository: string };
  post?: Record<string, string>;
  disabled?: string;
  auto?: 'now' | 'on-return';
}

export interface FixInput {
  // Whether the setup is complete, after which only the content sources are checked
  finished: boolean;
  me: { name: string; provider: string; groups: string[] } | null;
  readable: boolean;
  sources: string[];
  // What the checks of the GitHub sources found, by source, or null while they have not run
  checks: Map<string, SourceCheck> | null;
  discovering: string[];
  rows: RepositoryTableRow[];
  // Whether the instance publishes a repository to everyone, by its name, e.g. `acme/handbook`
  allowsPublic: (repository: string) => boolean;
}

/** The steps that come before the repositories, whose page shows nothing else */
export const BLOCKING_FIXES: RepositoryFix['id'][] = ['administrator', 'group', 'source'];

/**
 * nextFix returns the most important thing that keeps the administrator from reading a repository. It returns null
 * when nothing does.
 *
 * @param input what the page knows about the administrator, the content sources and the repositories
 */
export function nextFix(input: FixInput): RepositoryFix | null {
  if (!input.finished) {
    if (input.readable) return null;
    if (!input.me) {
      return {
        id: 'administrator',
        waits: false,
        title: 'Sign in as the administrator',
        text: 'Sign in with an identity provider, so you can add yourself to a group.',
        action: { label: 'Become the administrator', href: '/-/setup/administrator' },
      };
    }
    if (input.me.groups.length === 0) {
      return {
        id: 'group',
        waits: false,
        title: 'Add yourself to a group',
        text: `You are signed in as ${input.me.name} with ${input.me.provider}, but you are not a member of any group. A repository grants read access to groups, so add yourself to one.`,
        action: { label: 'Open groups', href: '/-/config/groups' },
      };
    }
    if (input.sources.length === 0 && input.rows.length === 0) {
      return {
        id: 'source',
        waits: false,
        title: 'Add a content source',
        text: 'A content source is the location from which speicher.md reads your repositories.',
        action: { label: 'Open content sources', href: '/-/config/sources' },
      };
    }
  }
  if (input.checks === null) {
    return {
      id: 'checking',
      waits: true,
      title: 'Checking your repositories on GitHub',
    };
  }
  const sourceFix = fixOfSources(input.checks, input.rows);
  if (sourceFix || input.finished) return sourceFix;
  return fixOfRepositories(input, input.me?.groups ?? []);
}

// A GitHub source that cannot be checked, or whose App reads no repository
function fixOfSources(
  checks: Map<string, SourceCheck>,
  rows: RepositoryTableRow[],
): RepositoryFix | null {
  for (const [id, check] of checks) {
    const reason = check.unchecked_reason;
    if (!reason) continue;
    if (reason.href && reason.label) {
      return {
        id: 'install',
        waits: false,
        title: 'Install the GitHub App',
        text: reason.text,
        action: { label: reason.label, href: reason.href, external: true },
      };
    }
    return {
      id: 'check-failed',
      waits: false,
      title: `speicher.md could not check the repositories of ${id}`,
      text: reason.text,
      action: {
        label: 'Open the content source',
        href: `/-/config/sources/${encodeURIComponent(id)}`,
      },
    };
  }
  for (const [id, check] of checks) {
    if (check.checked_repositories.length > 0 || !check.github_installation_href) continue;
    if (rows.some((row) => row.source === id)) continue;
    if (check.repository_selection === 'all-repositories' && check.installation_account) {
      return {
        id: 'create-repository',
        waits: false,
        title: `Create a repository on ${check.installation_account}`,
        text: `The GitHub App can read all repositories of **${check.installation_account}**, but the account has no repositories yet. Create a repository for your Markdown pages.`,
        action: check.create_repository_href
          ? { label: 'Create a repository', href: check.create_repository_href, external: true }
          : undefined,
        secondary: {
          label: 'Open the installation',
          href: check.github_installation_href,
          external: true,
        },
      };
    }
    return {
      id: 'no-repository',
      waits: false,
      title: 'Give the GitHub App access to a repository',
      text: 'The App is installed, but it cannot read any repositories. Add the repositories you want to publish to its installation.',
      action: {
        label: 'Open the installation',
        href: check.github_installation_href,
        external: true,
      },
    };
  }
  return null;
}

function fixOfRepositories(input: FixInput, mine: string[]): RepositoryFix {
  const rows = input.rows;
  if (rows.length === 0) {
    if (input.discovering.length > 0) {
      return {
        id: 'discovering',
        waits: true,
        title: 'speicher.md is looking for your repositories',
        text: `speicher.md is discovering the repositories of ${input.discovering.join(', ')}.`,
      };
    }
    const unchecked = input.sources.find((id) => !input.checks?.has(id));
    if (unchecked) {
      return {
        id: 'add-repository',
        waits: false,
        title: 'Add a repository to the content source',
        text: `The content source ${unchecked} has no repository yet. Add the repositories you want to publish.`,
        action: {
          label: 'Open the content source',
          href: `/-/config/sources/${encodeURIComponent(unchecked)}`,
        },
      };
    }
    return {
      id: 'not-found',
      waits: true,
      title: 'speicher.md is looking for your repositories',
      text: 'speicher.md has not found a repository yet. It will check the content sources regularly.',
    };
  }

  const yours = mine.map((group) => `\`${group}\``).join(', ');
  // Everyone reads a repository that grants `public`, once the instance publishes it
  const publishes = (row: RepositoryTableRow) =>
    row.groups?.includes(PUBLIC_GROUP_NAME) === true && input.allowsPublic(row.name);
  const grants = (row: RepositoryTableRow) =>
    row.groups === null ? null : publishes(row) || row.groups.some((group) => mine.includes(group));
  const present = rows.filter((row) => row.file.level === 'ok');

  const candidates = present.filter(
    (row) =>
      grants(row) === true ||
      (grants(row) === null && (row.sync.state !== 'ok' || row.sync.documents === 0)),
  );

  const granted = candidates.find((row) => !syncDone(row)) ?? candidates[0];
  if (granted) {
    if (granted.groups?.includes(PUBLIC_GROUP_NAME) && !input.allowsPublic(granted.name)) {
      return fixOfPublic(input, granted);
    }
    if (!granted.synced) return fixOfUnregistered(input, granted);
    if (granted.sync.state === 'failed') {
      return {
        id: 'sync-failed',
        waits: false,
        title: `The sync of ${granted.name} failed`,
        text: 'Once the cause is fixed, sync the repository again.',
        detail: granted.sync.last_error ?? 'The sync stopped with an error.',
        action: {
          label: 'Sync again',
          href: '/-/sync',
          post: { ...granted.synced, back: 'repositories' },
        },
        secondary: { label: 'Open the sync status', href: granted.status_href ?? '/-/status' },
      };
    }
    if (syncDone(granted)) return fixOfSynced(granted, yours);
    return {
      id: 'syncing',
      waits: true,
      title: `speicher.md is syncing ${granted.name}`,
      text: `${publishes(granted) ? 'Its `.speicher.yaml` grants everyone read access.' : 'Its `.speicher.yaml` grants one of your groups read access.'} You can read it once the sync is done.`,
    };
  }

  // Granted to everyone, but the instance does not publish it yet
  const unlisted = present.find((row) => row.groups?.includes(PUBLIC_GROUP_NAME));
  if (unlisted) return fixOfPublic(input, unlisted);

  const other = present[0];
  if (other) {
    const names = other.groups?.map((group) => `\`${group}\``).join(', ');
    return {
      id: 'no-grant',
      waits: false,
      title: `Grant your group access to ${other.name}`,
      text: `${names ? `Its \`.speicher.yaml\` lets ${names} read it, but you are in ${yours}.` : `Its \`.speicher.yaml\` grants none of your groups read access.`} Add ${yours} to the groups under \`access\`.`,
      action: editAction(other),
    };
  }

  const missing = rows.find((row) => row.file.level === 'warn' && !row.file.misnamed);
  if (missing) {
    return {
      id: 'missing-group',
      waits: false,
      title: `Create the missing group for ${missing.name}`,
      text: `The \`.speicher.yaml\` of ${missing.name} refers to a group that does not exist on this instance. Create the group, or correct its name in the file.`,
      detail: missing.access?.text,
      action: {
        label: 'Create the missing groups',
        href: missing.source ? sourceGroupsPath(missing.source) : '/-/config/groups',
      },
      secondary: editAction(missing),
    };
  }

  const invalid = rows.find((row) => row.file.level === 'fail');
  if (invalid) {
    return {
      id: 'invalid',
      waits: false,
      title: `Fix the \`.speicher.yaml\` of ${invalid.name}`,
      text: invalid.access?.text ?? 'The file is not valid.',
      action: editAction(invalid),
    };
  }

  const misnamed = rows.find((row) => row.file.misnamed);
  if (misnamed?.file.misnamed) {
    return {
      id: 'misnamed',
      waits: false,
      title: `Rename \`${misnamed.file.misnamed}\` in ${misnamed.name}`,
      text: misnamedConfigMessage(misnamed.file.misnamed),
      action: misnamed.file.edit_href
        ? { label: 'Rename on GitHub', href: misnamed.file.edit_href, external: true }
        : undefined,
    };
  }

  const creatable = rows.filter((row) => row.file.create_action);
  const copied = rows.some((row) => row.file.copy);
  const only = creatable.length === 1 ? creatable[0] : undefined;
  return {
    id: 'no-file',
    waits: false,
    title: 'Add a `.speicher.yaml` to a repository',
    text: `A repository is published once it has a \`.speicher.yaml\` file at its root. The file grants ${yours} read access.${
      creatable.length > 1 ? ' Choose **Create** next to the repository you want to publish.' : ''
    }${copied && !only ? ' Commit this file as `.speicher.yaml` to the repository you want to publish:' : ''}`,
    action:
      only && only.file.create_href && only.file.create_action
        ? {
            label: `Create it in ${only.name}`,
            href: only.file.create_href,
            create: { action: only.file.create_action, repository: only.name },
          }
        : undefined,
    snippet: copied && !only,
  };
}

// A repository that grants `public`, which the instance does not publish yet
function fixOfPublic(input: FixInput, row: RepositoryTableRow): RepositoryFix {
  // As the list of public repositories names it
  const listed = publicRepoRef(row.name);
  const name = `${slugify(listed.namespace)}/${listed.slug}`;
  return {
    id: 'public',
    waits: false,
    title: `Allow public access to ${row.name}`,
    text: `The \`.speicher.yaml\` of ${row.name} grants \`public\` read access. To allow a repository to be accessible to everyone, an administrator must additionally add it to the list of public repositories in the instance's configuration. If you really want to allow public access to this repository, add it to that list.`,
    detail: `Repository: \`${name}\``,
    action: {
      label: 'Add to public repositories',
      href: `/-/config/public?${new URLSearchParams({ pick: name })}`,
      ...(row.synced
        ? {}
        : {
            disabled:
              input.discovering.length > 0
                ? 'speicher.md is synchronizing the repository. You can add it once that is done.'
                : 'You can add the repository once it is synchronized.',
          }),
    },
    secondary:
      row.synced || input.discovering.length > 0 ? editAction(row) : discoverAction(row.source),
  };
}

// A repository the GitHub check knows, which Speicher.md has not synchronized yet
function fixOfUnregistered(input: FixInput, row: RepositoryTableRow): RepositoryFix {
  if (input.discovering.length > 0) {
    return {
      id: 'discovering',
      waits: true,
      title: `speicher.md is synchronizing ${row.name}`,
      text: `speicher.md is checking ${input.discovering.join(', ')} for new repositories.`,
    };
  }
  return {
    id: 'discover',
    waits: false,
    title: `${row.name} is not synchronized yet`,
    text: 'speicher.md synchronizes a repository when it changes, for example with a new commit, and on a regular schedule. Start the synchronization now.',
    action: { ...discoverAction(row.source), auto: 'now' },
  };
}

function syncDone(row: RepositoryTableRow): boolean {
  return (
    row.synced !== null &&
    row.sync.activity === null &&
    (row.sync.state === 'ok' || row.sync.state === 'stale')
  );
}

function fixOfSynced(row: RepositoryTableRow, yours: string): RepositoryFix {
  const status = { label: 'Open the sync status', href: row.status_href ?? '/-/status' };
  const pages = row.sync.documents;
  if (pages === 0) {
    const sync: FixAction = {
      label: 'Sync again',
      href: '/-/sync',
      post: { ...row.synced, back: 'repositories' },
      auto: 'on-return',
    };
    return {
      id: 'no-page',
      waits: false,
      title: `Add a page to ${row.name}`,
      text: `speicher.md synced ${row.name}, but the repository has no Markdown pages yet. Add a \`.md\` file to it, for example \`index.md\`.`,
      action: row.new_page_href
        ? { label: 'Add a page on GitHub', href: row.new_page_href, external: true }
        : sync,
      secondary: row.new_page_href ? sync : undefined,
    };
  }
  return {
    id: 'no-readable-page',
    waits: false,
    title: `You cannot read any page of ${row.name}`,
    text: `speicher.md synced ${pages} ${pages === 1 ? 'page' : 'pages'} of ${row.name}, but you are not allowed to read any of them. Add ${yours} to the \`access\` of the folder you want to read.`,
    action: status,
  };
}

function discoverAction(source: string | null): FixAction {
  return {
    label: 'Synchronize now',
    href: '/-/discover',
    post: { back: 'repositories', ...(source ? { source } : {}) },
  };
}

function editAction(row: RepositoryTableRow): FixAction | undefined {
  return row.file.edit_href
    ? { label: 'Edit on GitHub', href: row.file.edit_href, external: true }
    : undefined;
}
