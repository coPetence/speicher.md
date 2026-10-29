import { PUBLIC_GROUP_NAME } from '../../common/principals';
import { slugify } from '../../common/slug';
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
    | 'discovering'
    | 'discover'
    | 'add-repository'
    | 'not-found'
    | 'no-file'
    | 'invalid'
    | 'missing-group'
    | 'no-grant'
    | 'public'
    | 'sync-failed'
    | 'syncing';
  waits: boolean;
  title: string;
  text: string;
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
        text: 'A content source is the location from which Speicher.md reads your repositories.',
        action: { label: 'Open content sources', href: '/-/config/sources' },
      };
    }
  }
  if (input.checks === null) {
    return {
      id: 'checking',
      waits: true,
      title: 'Checking your repositories on GitHub',
      text: 'Speicher.md lists the repositories the GitHub App has access to. Then it reads the `.speicher.yaml` file of each repository.',
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
    if (!check.problem) continue;
    if (check.problem.href && check.problem.label) {
      return {
        id: 'install',
        waits: false,
        title: 'Install the GitHub App',
        text: check.problem.text,
        action: { label: check.problem.label, href: check.problem.href, external: true },
      };
    }
    return {
      id: 'check-failed',
      waits: false,
      title: `Speicher.md could not check the repositories of ${id}`,
      text: check.problem.text,
      action: {
        label: 'Open the content source',
        href: `/-/config/sources/${encodeURIComponent(id)}`,
      },
    };
  }
  for (const [id, check] of checks) {
    if (check.repositories.length > 0 || !check.installation_href) continue;
    if (rows.some((row) => row.source === id)) continue;
    return {
      id: 'no-repository',
      waits: false,
      title: 'Give the GitHub App access to a repository',
      text: 'The App is installed, but it cannot read any repositories. Add the repositories you want to publish to its installation.',
      action: { label: 'Open the installation', href: check.installation_href, external: true },
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
        title: 'Speicher.md is looking for your repositories',
        text: `Speicher.md is discovering the repositories of ${input.discovering.join(', ')}.`,
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
      title: 'Speicher.md is looking for your repositories',
      text: 'Speicher.md has not found a repository yet. It will check the content sources regularly.',
    };
  }

  const yours = mine.map((group) => `\`${group}\``).join(', ');
  // Everyone reads a repository that grants `public`, once the instance publishes it
  const publishes = (row: RepositoryTableRow) =>
    row.groups?.includes(PUBLIC_GROUP_NAME) === true && input.allowsPublic(row.name);
  const grants = (row: RepositoryTableRow) =>
    row.groups === null ? null : publishes(row) || row.groups.some((group) => mine.includes(group));
  const present = rows.filter((row) => row.file.level === 'ok');

  // Granted to the administrator, or synced with a file no check has read: only the sync is left
  const granted = present.find(
    (row) => grants(row) === true || (grants(row) === null && row.sync.state !== 'ok'),
  );
  if (granted) {
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
    return {
      id: 'syncing',
      waits: true,
      title: `Speicher.md is syncing ${granted.name}`,
      text: `${publishes(granted) ? 'Its `.speicher.yaml` grants everyone read access.' : 'Its `.speicher.yaml` grants one of your groups read access.'} You can read it once the sync is done.`,
    };
  }

  // Granted to everyone, but the instance does not publish it yet
  const unlisted = present.find((row) => row.groups?.includes(PUBLIC_GROUP_NAME));
  if (unlisted) {
    // As the list of public repositories names it
    const listed = publicRepoRef(unlisted.name);
    const name = `${slugify(listed.namespace)}/${listed.slug}`;
    return {
      id: 'public',
      waits: false,
      title: `Allow public access to ${unlisted.name}`,
      text: `The \`.speicher.yaml\` of ${unlisted.name} grants \`public\` read access. To allow a repository to be accessible to everyone, an administrator must additionally add it to the list of public repositories in the instance's configuration. If you really want to allow public access to this repository, add it to that list.`,
      detail: `Repository: \`${name}\``,
      action: {
        label: 'Add to public repositories',
        href: `/-/config/public?${new URLSearchParams({ pick: name })}`,
        ...(unlisted.synced
          ? {}
          : {
              disabled:
                input.discovering.length > 0
                  ? 'Speicher.md is synchronizing the repository. You can add it once that is done.'
                  : 'You can add the repository once it is synchronized.',
            }),
      },
      secondary:
        unlisted.synced || input.discovering.length > 0 ? editAction(unlisted) : discoverAction(),
    };
  }

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

  const missing = rows.find((row) => row.file.level === 'warn');
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

// A repository the GitHub check knows, which Speicher.md has not synchronized yet
function fixOfUnregistered(input: FixInput, row: RepositoryTableRow): RepositoryFix {
  if (input.discovering.length > 0) {
    return {
      id: 'discovering',
      waits: true,
      title: `Speicher.md is synchronizing ${row.name}`,
      text: `Speicher.md is checking ${input.discovering.join(', ')} for new repositories.`,
    };
  }
  return {
    id: 'discover',
    waits: false,
    title: `${row.name} is not synchronized yet`,
    text: 'Speicher.md synchronizes a repository when it changes, for example with a new commit, and on a regular schedule. Start the synchronization now.',
    action: discoverAction(),
  };
}

function discoverAction(): FixAction {
  return { label: 'Synchronize now', href: '/-/discover', post: { back: 'repositories' } };
}

function editAction(row: RepositoryTableRow): FixAction | undefined {
  return row.file.edit_href
    ? { label: 'Edit on GitHub', href: row.file.edit_href, external: true }
    : undefined;
}
