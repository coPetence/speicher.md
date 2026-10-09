/**
 * Groups, and the sources they draw from
 *
 * The widest surface here, because a group maps a name to directory group ids
 * *and* may name people, and those are two tables built from one sequence. The
 * first column is headed by the provider's own name, so the entry is a provider
 * rather than a position; `sourcePositions` turns a name back into positions
 *
 * A trailing row carries nothing, so an opened-and-saved page goes back out byte
 * for byte
 */

import { scalarString } from '../../document';
import { at } from '../../config-fields';
import type { Obj } from '../../config-fields';
import type { SectionEntry } from '../../model';
import {
  GROUP_ID_HELP,
  GROUP_NAME,
  GROUP_NAME_HINT,
  groupNames,
  groupProviders,
  memberSectionId,
  nounOf,
  providerMark,
  sourcePositions,
} from '../../members';
import { sectionHead } from '../registry';
import type { SectionSource } from '../registry';
import { matchLine } from './source-fields';

/** The groups index: one row per group, and what each one draws from. */

export function groupsSection(root: Obj): SectionSource {
  const names = groupNames(root);
  const admins = ((at(root, ['admins', 'groups']) as unknown[]) ?? []).map((v) => scalarString(v));

  return {
    ...sectionHead('groups'),
    blurb:
      'Manage internal groups so that it can be referenced in your `.speicher.yaml` files. Find out more in our [documentation](https://docs.speicher.md/access/groups)',
    fields: [],
    entries: names.map((name) => groupEntry(root, name, admins)),
    layout: 'table',
    columns: ['Group', 'Sources', 'Added by', 'Added'],
    searchable: true,
    // Search covers group name, provider id and group ids
    searchPlaceholder: 'Name, provider or group id',
    entryNoun: nounOf('groups'),
    cards: [],
    addOps: [
      {
        op: 'add:groups',
        label: 'Add a group',
        nameLabel: 'Short id',
        nameHelp: GROUP_ID_HELP,
        namePattern: GROUP_NAME.source.slice(1, -1),
        nameHint: GROUP_NAME_HINT,
        // Groups have no type selection
        typeLabel: null,
        typeOptions: [],
        // Navigates to the new group's detail page
        opensPage: true,
      },
    ],
  };
}

function providerLine(root: Obj, name: string, provider: string, elide: boolean): string {
  const matches = sourcePositions(root, name, provider).map(
    (index) => matchLine(root, name, index, elide).value,
  );
  return `${provider || 'no provider'} (${matches.join(', ')})`;
}

function groupEntry(root: Obj, name: string, adminGroups: string[]): SectionEntry {
  const providers = groupProviders(root, name);
  const isAdmin = adminGroups.includes(name);
  return {
    href: `/-/config/${memberSectionId('groups', name)}`,
    title: name,
    subtitle: '',
    mark: '',
    icon: '',
    badges: isAdmin ? [{ label: 'Administrators', icon: 'shield' }] : [],
    lines:
      providers.length === 0
        ? [{ label: '', value: 'no sources yet', mark: '' }]
        : providers.map((provider) => ({
            label: '',
            value: providerLine(root, name, provider, true),
            mark: providerMark(root, provider),
          })),
    cells: [],
    search: [
      name,
      ...(isAdmin ? ['administrators'] : []),
      ...providers.map((provider) => providerLine(root, name, provider, false)),
    ]
      .join(' ')
      .toLowerCase(),
    fields: [],
    carried: [],
    removeOp: `remove:groups.${name}`,
    position: -1,
  };
}
