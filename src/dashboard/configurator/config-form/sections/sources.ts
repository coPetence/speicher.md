/**
 * Content sources: the forges, and a plain remote's repositories
 *
 * A forge's kind is not a setting, for the reason a provider's is not: the id is
 * a URL segment and the key of a materialised row. A plain remote's repository
 * id is admin-chosen rather than derived from the URL, and the character set
 * below protects the mirror directory
 */

import { webhookPath, webhookUrl } from '../../../../forge/webhook-url';

import { scalarString } from '../document';
import { SECRET_HELP, at, field } from '../field';
import type { Obj } from '../field';
import type { Card, EntryLine, Field, SectionEntry } from '../model';
import {
  FORGE_TYPES,
  SHORT_ID,
  SHORT_ID_HINT,
  forgeIds,
  forgeLabel,
  forgeMark,
  forgeType,
  freeMemberId,
  memberSectionId,
  nounOf,
} from '../members';
import { sectionHead } from './registry';
import type { SectionSource } from './registry';

const REPO_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9._\\-]{0,99}';
const REPO_ID_HINT =
  'Letters, digits, dots, underscores and hyphens, starting with a letter or digit. Up to 100 characters.';

export function sourcesSection(root: Obj): SectionSource {
  const ids = forgeIds(root);

  return {
    ...sectionHead('sources'),
    blurb:
      'Where documentation is read from. Exactly one source is primary; it ' +
      'contributes no URL segment, so promoting a different one moves every URL ' +
      'on the instance.',
    fields: [],
    entries: ids.map((id) => forgeEntry(root, id)),
    layout: 'table',
    columns: ['Source', 'Default repository owner', 'Added by', 'Added'],
    searchable: true,
    // Search covers source name, kind and default repository owner
    searchPlaceholder: 'Name, kind or owner',
    entryNoun: nounOf('sources'),
    cards: [],
    addOps: [
      {
        op: 'add:forges',
        label: 'Add a source',
        nameLabel: 'Short id',
        namePattern: SHORT_ID.source.slice(1, -1),
        nameHint: SHORT_ID_HINT,
        typeLabel: 'Kind',
        // Forge types with suggested ids
        typeOptions: FORGE_TYPES.map((entry) => ({
          value: entry.value,
          label: entry.label,
          suggest: freeMemberId(ids, entry.value),
          mark: entry.mark,
        })),
        // Navigates to the new forge's detail page
        opensPage: true,
      },
    ],
  };
}

function defaultOwnerLines(root: Obj, id: string): EntryLine[] {
  const owner = scalarString(at(root, ['forges', id, 'default_repository_owner']));
  return owner === '' ? [] : [{ label: '', value: owner, mark: '' }];
}

function forgeEntry(root: Obj, id: string): SectionEntry {
  const type = forgeType(root, id);
  const lines = defaultOwnerLines(root, id);

  return {
    href: `/-/config/${memberSectionId('sources', id)}`,
    title: id,
    subtitle: forgeLabel(type),
    mark: forgeMark(type),
    icon: '',
    // Primary badge for the source with no URL segment
    badges:
      at(root, ['forges', id, 'primary']) === true ? [{ label: 'Primary', icon: 'star' }] : [],
    lines,
    cells: [],
    search: [id, forgeLabel(type), type, ...lines.map((line) => line.value)]
      .join(' ')
      .toLowerCase(),
    fields: [],
    carried: [],
    removeOp: `remove:forges.${id}`,
    position: -1,
  };
}

function webhookFact(id: string): string {
  const url = webhookUrl(id);
  if (url) return `Deliveries arrive at \`${url}\` — the **Webhook URL** the App asks for.`;
  return (
    `Deliveries arrive at \`${webhookPath(id)}\` on this instance. ` +
    'The absolute URL the App asks for is this path under `SPEICHER_PUBLIC_URL`, ' +
    'which is unset: the origin is never taken from the request.'
  );
}

function forgeBlurb(type: string): string {
  if (type === 'git') {
    return (
      'A plain git remote, behind no forge API. Its repositories are listed here ' +
      'rather than discovered, freshness comes from polling rather than a webhook, ' +
      'and there is no pull-request check — which is what makes an unsupported ' +
      'forge a yes rather than a permanent no.'
    );
  }
  if (type === 'github') {
    return (
      'A GitHub App. Repositories are discovered through it, and a webhook is what ' +
      'makes a push visible here without waiting for a poll.'
    );
  }
  return (
    'No driver is built for this kind yet. A plain git remote serves the same ' +
    'repositories today, without discovery or the pull-request check.'
  );
}

export function forgeSection(root: Obj, id: string): SectionSource {
  const base = ['forges', id];
  const type = forgeType(root, id);
  const p = (key: string) => `forges.<key>.${key}`;

  // Advanced fields may not sit in a card, so the base URL stays on the section
  const fields: Field[] = [
    field(root, [...base, 'base_url'], p('base_url'), 'Base URL', 'text', {
      placeholder: 'https://github.example.com',
      help: 'Self-hosted installations only.',
      advanced: true,
    }),
  ];

  const repos = (at(root, [...base, 'repos']) as unknown[]) ?? [];
  const cards: Card[] =
    type === 'git'
      ? [
          urlCard(root, id),
          fetchingCard(root, id),
          ...repos.map((_, index) => repoCard(root, id, index)),
        ]
      : [appCard(root, id), urlCard(root, id)];

  return {
    id: memberSectionId('sources', id),
    title: id,
    parent: 'sources',
    mark: forgeMark(type),
    blurb: forgeBlurb(type),
    fields,
    entries: [],
    cards,
    addOps:
      type === 'git'
        ? [
            {
              op: `add:forges.${id}.repos`,
              label: 'Add a repository',
              nameLabel: null,
              namePattern: null,
              nameHint: null,
              typeLabel: null,
              typeOptions: [],
            },
          ]
        : [],
    removeOp: `remove:forges.${id}`,
    noun: nounOf('sources'),
  };
}

/**
 * appCard builds the card holding the credentials of a GitHub App.
 *
 * @param root the configuration document
 * @param id the forge's key
 */
function appCard(root: Obj, id: string): Card {
  const base = ['forges', id];
  const p = (key: string) => `forges.<key>.${key}`;
  return {
    title: 'GitHub App',
    subtitle: 'The values from the settings page of the GitHub App.',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    fields: [
      field(root, [...base, 'app_id'], p('app_id'), 'App id', 'text'),
      field(root, [...base, 'private_key'], p('private_key'), 'Private key', 'secret', {
        help:
          SECRET_HELP +
          ' The App’s `.pem` can be chosen below instead, and then the key itself is ' +
          'what is stored — every version of this configuration keeps a copy of it, ' +
          'so ${VARIABLE_NAME} is still the better answer where there is an ' +
          'environment to hold one.',
        upload: {
          accept: '.pem,application/x-pem-file',
          content: 'rsa-private-key',
          label: '… or choose the App’s .pem file',
        },
      }),
      field(root, [...base, 'webhook_secret'], p('webhook_secret'), 'Webhook secret', 'secret', {
        help: SECRET_HELP,
        fact: webhookFact(id),
        startsRow: true,
      }),
    ],
  };
}

/**
 * urlCard builds the card deciding how the repositories of a source appear in URLs.
 *
 * @param root the configuration document
 * @param id the forge's key
 */
function urlCard(root: Obj, id: string): Card {
  const base = ['forges', id];
  const p = (key: string) => `forges.<key>.${key}`;
  return {
    title: 'URLs',
    subtitle: 'How the repositories of this source appear in the URLs of this instance.',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    fields: [
      field(
        root,
        [...base, 'default_repository_owner'],
        p('default_repository_owner'),
        'Default repository owner',
        'text',
        {
          placeholder: 'acme',
          help: 'The user or organization whose name should be left out of the URL, so its repositories are served at `/<repo>` instead of `/<owner>/<repo>`. Leave it empty to put the owner in every URL.',
        },
      ),
      field(root, [...base, 'primary'], p('primary'), 'Primary', 'boolean', {
        fallback: false,
        help:
          'The primary source contributes no URL segment. Exactly one, and changing ' +
          'which moves every URL on this instance.',
      }),
    ],
  };
}

/**
 * fetchingCard builds the card deciding how a plain git source reads its remotes.
 *
 * @param root the configuration document
 * @param id the forge's key
 */
function fetchingCard(root: Obj, id: string): Card {
  const base = ['forges', id];
  const p = (key: string) => `forges.<key>.${key}`;
  return {
    title: 'Fetching',
    subtitle: 'How often the remotes are read, and the SSH host keys they are checked against.',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    fields: [
      field(root, [...base, 'poll_interval'], p('poll_interval'), 'Poll interval', 'duration', {
        fallback: '1h',
        help:
          'A plain remote sends no webhooks, so polling is the only freshness ' +
          'signal there is.',
      }),
      field(root, [...base, 'known_hosts'], p('known_hosts'), 'Known hosts', 'multiline', {
        help:
          'The SSH host key, pinned. There is no trust-on-first-use: an unattended ' +
          'poller that accepts an unknown key does it once, quietly, and then keeps ' +
          'trusting it.',
        rows: 3,
        startsRow: true,
      }),
    ],
  };
}

function repoCard(root: Obj, forgeId: string, index: number): Card {
  const base = ['forges', forgeId, 'repos', index];
  const p = (key: string) => `forges.<key>.repos.<index>.${key}`;
  const url = scalarString(at(root, [...base, 'url']));
  const ssh = url.startsWith('ssh://');

  const fields: Field[] = [
    field(root, [...base, 'id'], p('id'), 'Repository id', 'text', {
      pattern: REPO_ID_PATTERN,
      patternHint: REPO_ID_HINT,
      help:
        'Chosen here, not derived from the URL — so moving the remote to a new ' +
        'host does not read as a different repository and break every link. It ' +
        'names this repository’s mirror on disk, so it starts with a letter or a ' +
        'digit; it is not the URL, which is the slug below.',
    }),
    field(root, [...base, 'url'], p('url'), 'Remote URL', 'text', {
      placeholder: 'ssh://git@example.com/team/docs.git',
      help: 'ssh:// with a deploy key, or https:// with a token. Nothing else is fetched. The path before the repository name is its owner, for example `team` in `ssh://git@example.com/team/docs.git`.',
    }),
    field(root, [...base, 'slug'], p('slug'), 'URL slug', 'text', {
      help: 'Defaults to the id. Changing it leaves the old path serving a redirect.',
    }),
    field(root, [...base, 'branch'], p('branch'), 'Branch', 'text', {
      placeholder: 'main',
    }),
  ];

  if (ssh) {
    fields.push(
      field(root, [...base, 'deploy_key'], p('deploy_key'), 'Deploy key', 'secret', {
        help: SECRET_HELP,
      }),
      field(root, [...base, 'known_hosts'], p('known_hosts'), 'Known hosts', 'multiline', {
        help: 'Overrides the source-wide pin for this repository.',
        rows: 3,
      }),
    );
  } else {
    fields.push(
      field(root, [...base, 'token'], p('token'), 'Access token', 'secret', {
        help: SECRET_HELP,
      }),
      field(root, [...base, 'username'], p('username'), 'Username', 'text', {
        fallback: 'x-access-token',
        placeholder: 'x-access-token',
      }),
    );
  }

  fields.push(
    field(root, [...base, 'poll_interval'], p('poll_interval'), 'Poll interval', 'duration', {
      help: 'Overrides the source-wide interval for this repository.',
    }),
  );

  const id = scalarString(at(root, [...base, 'id']));

  return {
    // The one card whose heading is a document key: it is the mirror directory's
    // name and what `speicher sync-repo-content <id>` takes, so it is a string an operator
    // pastes. An entry with no id yet is counted instead, and that is prose.
    title: id || `Repository ${index + 1}`,
    titleIsKey: id !== '',
    subtitle: url,
    removeOp: `remove:forges.${forgeId}.repos.${index}`,
    fields,
    cards: [],
    addOps: [],
    notes: [],
  };
}
