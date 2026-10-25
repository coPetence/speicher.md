import { describeExpiry, isExpired } from '../../../../../common/until';
import { referrersOf } from '../../../../../config/groups';
import type { GroupItem } from '../../../../../config/types';
import { SOURCE_GROUP, SOURCE_PERSON, SOURCE_REFERENCE } from '../../collections';
import { scalarString } from '../../document';
import { at, membershipField, selectField, textField } from '../../config-fields';
import type { Field, Obj } from '../../config-fields';
import type { SectionEntry, TableAdd } from '../../model';
import {
  GROUP_NAME,
  GROUP_NAME_HINT,
  groupItems,
  groupNames,
  isReferenceItem,
  memberSectionId,
  nounOf,
  providerIds,
  providerMark,
  providerType,
} from '../../members';
import type { SectionSource } from '../registry';
import {
  matchFields,
  matchLine,
  personFields,
  portalUrlFor,
  sourceNoteFields,
} from './source-fields';

export function groupSection(root: Obj, name: string): SectionSource {
  const ids = providerIds(root);
  const items = groupItems(root, name);
  // A group that already reaches this one would close a cycle the save refuses
  const referrers = referrersOf(at(root, ['groups']) as Record<string, GroupItem[]>, name);
  const others = groupNames(root).filter((other) => other !== name && !referrers.includes(other));
  const referenced = items.filter(isReferenceItem).map((item) => scalarString(item.group));

  return {
    id: memberSectionId('groups', name),
    title: name,
    parent: 'groups',
    blurb:
      'This group is made of the members of the providers and groups listed below. Find out more in our [documentation](https://docs.speicher.md/configuration/groups).',
    fields: [
      // Membership checkbox marking this group as an administrator group
      membershipField(root, ['admins', 'groups'], 'admins.groups', 'Administrator access', {
        trueValue: name,
        help: 'Mark this group as an administrator group, so that its members can manage the instance through the dashboard.',
      }),
    ],
    entries: [],
    cards: [],
    tables: [
      {
        title: '',
        // No header: a card says what it is and what it matches on its own
        columns: [],
        bulkRemoveOp: `remove-selected:groups.${name}`,
        entries: items.map((item, index) => rowEntry(root, name, index, item, others)),
        emptyNote: 'No members yet, so nobody can see anything through this group.',
        add: rowAdd(
          root,
          name,
          ids,
          others.filter((other) => !referenced.includes(other)),
        ),
      },
    ],
    addOps: [],
    removeOp: `remove:groups.${name}`,
    renameOp: `rename:groups.${name}`,
    renamePattern: GROUP_NAME.source.slice(1, -1),
    renameHint: GROUP_NAME_HINT,
    noun: nounOf('groups'),
    entryNoun: 'row',
  };
}

/**
 * The modal that appends a row
 */
function rowAdd(root: Obj, name: string, ids: string[], others: string[]): TableAdd | undefined {
  const providerOption = (id: string) => ({ value: id, label: id, mark: providerMark(root, id) });
  const magicLink = ids.filter((id) => providerType(root, id) === 'magic-link');
  const directory = ids.filter((id) => providerType(root, id) !== 'magic-link');
  const perLine =
    'One per line. Each becomes a row, so a note and an expiry can be written against it; leave it empty for one row to fill in on the page.';
  const kinds = [
    {
      value: SOURCE_GROUP,
      label: 'IDP group',
      icon: 'users',
      help: 'Everybody in a group of the provider, by the id the provider emits.',
      nameLabel: 'Provider',
      options: directory.map(providerOption),
      matches: {
        label: 'Group ids',
        placeholder: 'Entra object id, or org/team-slug on GitHub',
        help: perLine,
      },
    },
    {
      value: 'domain',
      label: 'Email domain',
      icon: 'at-sign',
      help: 'Everybody signing in with an address at a domain. Magic-link providers only.',
      nameLabel: 'Provider',
      options: magicLink.map(providerOption),
      matches: { label: 'Email domains', placeholder: 'example.com', help: perLine },
    },
    {
      value: SOURCE_PERSON,
      label: 'Individual email',
      icon: 'mail',
      help: 'One person, by email address.',
      nameLabel: 'Provider',
      options: ids.map(providerOption),
      matches: { label: 'Email addresses', placeholder: 'alice@example.com', help: perLine },
    },
    {
      value: SOURCE_REFERENCE,
      label: 'Another group',
      icon: 'layers',
      help: 'Every member of another internal group. Several may be picked at once, one row each.',
      nameLabel: 'Groups',
      options: others.map((other) => ({ value: other, label: other })),
      multiple: true,
    },
  ].filter((kind) => kind.options.length > 0);
  if (kinds.length === 0) return undefined;
  return {
    op: `add:groups.${name}.row`,
    label: 'Add members',
    title: `Add members to ${name}`,
    question: 'Who',
    kinds,
  };
}

function rowEntry(
  root: Obj,
  name: string,
  index: number,
  item: Obj,
  others: string[],
): SectionEntry {
  const reference = isReferenceItem(item);
  const provider = reference ? '' : scalarString(item.provider);
  const person = !reference && (item.subject !== undefined || item.email !== undefined);
  const line = matchLine(root, name, index, false);
  // A directory group in an Entra tenant links to its page in the portal
  const href =
    !reference && !person && item.id !== undefined
      ? portalUrlFor(root, provider, scalarString(item.id))
      : undefined;
  const until = scalarString(item.until);
  return {
    href: '',
    title: rowTitle(root, provider, reference, person),
    subtitle: provider,
    mark: providerMark(root, provider),
    icon: '',
    badges: [],
    // What the card shows while it is not being edited: the match, the note, and
    // the expiry in words with the date it stands for
    lines: [
      { ...line, href },
      { label: 'Note', value: scalarString(item.note), mark: '' },
      {
        label: 'Expire by',
        value: until === '' ? '' : `${describeExpiry(until)} (${until})`,
        mark: '',
        // Past, so the row matches nobody any more: said in the failure colour
        failed: until !== '' && isExpired(until, new Date()),
      },
    ],
    cells: [],
    search: `${line.label} ${line.value}`.toLowerCase(),
    fields: reference
      ? [
          ...referenceFields(root, name, index, others),
          ...sourceNoteFields(root, name, index, false),
        ]
      : person
        ? [...personFields(root, name, index), ...sourceNoteFields(root, name, index, true)]
        : [
            ...matchFields(root, name, index, provider),
            ...sourceNoteFields(root, name, index, false),
          ],
    // A source carries its provider, which no control on the row shows and every
    // save needs: a position rebuilt in another shape takes the provider from here
    carried: reference
      ? []
      : [
          textField(
            root,
            ['groups', name, index, 'provider'],
            'groups.<key>.<index>.provider',
            'Provider',
          ),
        ],
    removeOp: `remove:groups.${name}.${index}`,
    position: index,
    kind: reference ? SOURCE_REFERENCE : person ? SOURCE_PERSON : SOURCE_GROUP,
  };
}

/** What the first column calls the row */
function rowTitle(root: Obj, provider: string, reference: boolean, person: boolean): string {
  if (reference) return 'Group';
  if (person) return 'Individual email';
  return providerType(root, provider) === 'magic-link' ? 'Email domain' : 'IDP group';
}

/** The one control of a reference: which group, out of every other one there is */
function referenceFields(root: Obj, name: string, index: number, others: string[]): Field[] {
  const path = ['groups', name, index, 'group'];
  const stored = scalarString(at(root, path));
  return [
    selectField(root, path, 'groups.<key>.<index>.group', 'Group', {
      options: (others.includes(stored) || stored === '' ? others : [stored, ...others]).map(
        (other) => ({ value: other, label: other }),
      ),
    }),
  ];
}
