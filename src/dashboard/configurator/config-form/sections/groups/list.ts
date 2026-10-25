/**
 * List all the sources and references a group has
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
  referencePositions,
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
    columns: ['Group', 'Used in', 'Added by', 'Added'],
    hideLines: true,
    bulkRemoveOp: 'remove-selected:groups',
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

/** The groups a group references, as one line, or null when it references none */
function referenceLine(root: Obj, name: string): string | null {
  const names = referencePositions(root, name).map(
    (index) => matchLine(root, name, index, false).value,
  );
  return names.length === 0 ? null : `groups (${names.join(', ')})`;
}

function groupEntry(root: Obj, name: string, adminGroups: string[]): SectionEntry {
  const providers = groupProviders(root, name);
  const references = referenceLine(root, name);
  const isAdmin = adminGroups.includes(name);
  return {
    href: `/-/config/${memberSectionId('groups', name)}`,
    title: name,
    subtitle: '',
    mark: '',
    icon: '',
    badges: isAdmin ? [{ label: 'Administrators', icon: 'shield' }] : [],
    lines:
      providers.length === 0 && references === null
        ? [{ label: '', value: 'no sources yet', mark: '' }]
        : [
            ...providers.map((provider) => ({
              label: '',
              value: providerLine(root, name, provider, true),
              mark: providerMark(root, provider),
            })),
            ...(references === null ? [] : [{ label: '', value: references, mark: '' }]),
          ],
    cells: [],
    search: [
      name,
      ...(isAdmin ? ['administrators'] : []),
      ...providers.map((provider) => providerLine(root, name, provider, false)),
      ...(references === null ? [] : [references]),
    ]
      .join(' ')
      .toLowerCase(),
    fields: [],
    carried: [],
    removeOp: `remove:groups.${name}`,
    position: -1,
  };
}
