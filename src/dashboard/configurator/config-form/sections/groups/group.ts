import { scalarString } from '../../document';
import { at, membershipField, textField } from '../../config-fields';
import type { Field, Obj } from '../../config-fields';
import type { SectionEntry } from '../../model';
import {
  GROUP_NAME,
  GROUP_NAME_HINT,
  SHORT_ID,
  SHORT_ID_HINT,
  groupProviders,
  memberSectionId,
  nounOf,
  providerIds,
  providerMark,
  sourcePositions,
} from '../../members';
import type { SectionSource } from '../registry';
import { matchFields, matchLine, personFields, sourceNoteFields } from './source-fields';

/** One group's page: a row per provider it draws from, each opening that provider's sources. */

export function groupSection(root: Obj, name: string): SectionSource {
  const ids = providerIds(root);
  const providers = groupProviders(root, name);
  const isAdmin = ((at(root, ['admins', 'groups']) as unknown[]) ?? []).some(
    (value) => scalarString(value) === name,
  );

  return {
    id: memberSectionId('groups', name),
    title: name,
    parent: 'groups',
    blurb:
      'Every source below adds people to this one internal name, so a name may ' +
      'aggregate across providers. Membership is resolved per request: removing a ' +
      'source takes effect without waiting for anybody to sign in again.',
    fields: [
      // Membership checkbox marking this group as an administrator group
      membershipField(root, ['admins', 'groups'], 'admins.groups', 'Administrator access', {
        trueValue: name,
        help:
          'Members of this group may operate the instance: every surface under ' +
          '`/-/`, this configuration included. It grants no access to any page — ' +
          'administering the instance and reading its content are separate ' +
          'powers. The whole list is on [Administrators](/-/config/admins).',
      }),
    ],
    entries: providers.map((provider) => sourceEntry(root, name, provider, ids)),
    layout: 'table',
    columns: ['Provider', 'Matches'],
    entryNoun: 'source',
    cards: [],
    addOps: [
      {
        // Add a source under a specific provider within this group
        op: `add:groups.${name}`,
        label: 'Add a source',
        nameLabel: 'Provider',
        namePattern: SHORT_ID.source.slice(1, -1),
        nameHint: SHORT_ID_HINT,
        // Show existing providers as name options. Every one keeps its mark
        // however many there are: the closed box shows the checked row itself,
        // so the control is not bounded by a count of stylesheet rules.
        nameOptions: ids.map((id) => ({
          value: id,
          label: id,
          mark: providerMark(root, id),
        })),
        typeLabel: null,
        typeOptions: [],
        // Navigates to the new source page
        opensPage: true,
        // With one provider there is nothing to pick, so Add goes straight to it
        ...(ids.length === 1
          ? { href: `/-/config/${memberSectionId('groups', name, ids[0])}` }
          : {}),
      },
    ],
    removeOp: `remove:groups.${name}`,
    removeWarnings: [
      ...(providers.length > 0
        ? [
            `Its sources from ${providers.map((p) => `\`${p || 'no provider'}\``).join(', ')} ` +
              'go with it, and nobody is a member any more.',
          ]
        : []),
      ...(isAdmin ? ['Its members lose administrator access to this instance.'] : []),
    ],
    renameOp: `rename:groups.${name}`,
    renamePattern: GROUP_NAME.source.slice(1, -1),
    renameHint: GROUP_NAME_HINT,
    noun: nounOf('groups'),
  };
}

function sourceEntry(root: Obj, name: string, provider: string, ids: string[]): SectionEntry {
  const positions = sourcePositions(root, name, provider);

  return {
    // Empty href when there is no provider
    href: provider === '' ? '' : `/-/config/${memberSectionId('groups', name, provider)}`,
    title: provider || 'no provider',
    subtitle: '',
    mark: providerMark(root, provider),
    icon: '',
    badges: [],
    lines: positions.map((index) => matchLine(root, name, index, true)),
    cells: [],
    search: [provider, ...positions.map((index) => matchLine(root, name, index, false).value)]
      .join(' ')
      .toLowerCase(),
    fields: [],
    // Carry source fields into the detail page
    carried: positions.flatMap((index) => sourceFields(root, name, index, ids)),
    // Remove operation differs for named providers vs unnamed ones
    removeOp:
      provider === ''
        ? `remove:groups.${name}.${positions[0]}`
        : `remove:groups.${name}.provider.${provider}`,
    position: -1,
  };
}

function sourceFields(root: Obj, name: string, index: number, ids: string[]): Field[] {
  const base = ['groups', name, index];
  const p = (key: string) => `groups.<key>.<index>.${key}`;
  return [
    textField(root, [...base, 'provider'], p('provider'), 'Provider', {
      help:
        'Which provider this group is drawn from. It decides what the source can ' +
        'match on: a magic-link provider has no group ids, so it matches an email ' +
        'domain instead.',
    }),
    ...matchFields(root, name, index, sourceProvider(root, name, index, ids)),
    // Person fields for subject or email matches
    ...personFields(root, name, index),
    // Note and expiry fields shared by both source types
    ...sourceNoteFields(root, name, index, false),
  ];
}

function sourceProvider(root: Obj, name: string, index: number, ids: string[]): string {
  return scalarString(at(root, ['groups', name, index, 'provider'])) || ids[0] || '';
}
