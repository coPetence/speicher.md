import { SOURCE_GROUP, SOURCE_PERSON } from '../../collections';
import { at } from '../../config-fields';
import type { Obj } from '../../config-fields';
import { column } from '../../model';
import type { AddOp, SectionEntry } from '../../model';
import { memberSectionId, providerMark, providerType, sourcePositions } from '../../members';
import type { SectionSource } from '../registry';
import {
  matchFields,
  matchLine,
  personFields,
  sourceNoteFields,
  trailingCarry,
} from './source-fields';

/** One group's sources under one provider: the mappings table and the people table. */

const EXPIRE_BY_HELP =
  'Optional, and a real expiry rather than a reminder: membership is resolved on ' +
  'every request, so the day this passes the source stops matching. Nothing has to ' +
  'run for it — no rebuild, and nobody has to sign in again. Leave it empty for a ' +
  'grant with no end date.';

function isPersonSource(root: Obj, name: string, index: number): boolean {
  const source = (at(root, ['groups', name, index]) ?? {}) as Obj;
  return source.subject !== undefined || source.email !== undefined;
}

function positionsOfKind(root: Obj, name: string, provider: string, person: boolean): number[] {
  return sourcePositions(root, name, provider).filter(
    (index) => isPersonSource(root, name, index) === person,
  );
}

function matchEntry(
  root: Obj,
  name: string,
  index: number,
  provider: string,
  trailing = false,
  // A placeholder drawn as the trailing row still posts its provider, so the
  // source it stands for keeps it through a round trip
  carries = !trailing,
): SectionEntry {
  return {
    href: '',
    title: '',
    subtitle: '',
    mark: '',
    icon: '',
    badges: [],
    lines: [],
    cells: [],
    search: matchLine(root, name, index, false).value.toLowerCase(),
    fields: [
      ...matchFields(root, name, index, provider),
      ...sourceNoteFields(root, name, index, false),
    ],
    // The trailing entry carries the provider field for the add-row template
    carried: trailingCarry(root, name, index, !carries),
    removeOp: trailing ? null : `remove:groups.${name}.${index}`,
    position: index,
  };
}

function personEntry(root: Obj, name: string, index: number, trailing = false): SectionEntry {
  return {
    href: '',
    title: '',
    subtitle: '',
    mark: '',
    icon: '',
    badges: [],
    lines: [],
    cells: [],
    search: matchLine(root, name, index, false).value.toLowerCase(),
    fields: [...personFields(root, name, index), ...sourceNoteFields(root, name, index, true)],
    // The trailing entry carries the provider field for the add-row template
    carried: trailingCarry(root, name, index, trailing),
    removeOp: trailing ? null : `remove:groups.${name}.${index}`,
    position: index,
  };
}

/** A source carrying nothing but its provider: the placeholder a draft page is seeded with */
function isBare(root: Obj, name: string, index: number): boolean {
  return Object.keys((at(root, ['groups', name, index]) ?? {}) as Obj).every(
    (key) => key === 'provider',
  );
}

export function groupProviderSection(root: Obj, name: string, provider: string): SectionSource {
  // Separate group id mappings from person (subject/email) mappings
  const stored = positionsOfKind(root, name, provider, false);
  const people = positionsOfKind(root, name, provider, true);
  const magicLink = providerType(root, provider) === 'magic-link';
  const length = ((at(root, ['groups', name]) as unknown[]) ?? []).length;

  const seeded =
    stored.length > 0 && isBare(root, name, stored[stored.length - 1])
      ? stored[stored.length - 1]
      : null;
  const mappings = seeded === null ? stored : stored.slice(0, -1);
  const trailingAt = seeded ?? length;

  const heading = magicLink ? 'domain' : `${provider} group`;

  return {
    id: memberSectionId('groups', name, provider),
    title: provider,
    mark: providerMark(root, provider),
    parent: memberSectionId('groups', name),
    blurb:
      (magicLink
        ? 'This provider emits no group ids, so a mapping is an email domain: ' +
        'everybody signing in with an address at it. Never a freemail domain, ' +
        'which would grant anyone who can receive mail there. '
        : `Add a group from ${provider} by its object id, not its display name. ` +
        'Everyone in a mapped group becomes a member. ') +
      'To add individuals directly, list them under People. That is also the way ' +
      'to go when the provider sends no group ids at all.',
    fields: [],
    entries: [],
    cards: [],
    // Two add operations: one for group mappings, one for people
    addOps: [
      { ...declaredGrow(`add:groups.${name}.provider.${provider}`) },
      { ...declaredGrow(`add:groups.${name}.person.${provider}`) },
    ],
    tables: [
      {
        title: magicLink ? 'Email domains' : `${provider} groups`,
        columns: [
          magicLink
            ? column(
              'Email domain',
              'Everybody signing in with an address at this domain is a member. ' +
              'A magic-link provider emits no group ids, so this is what it ' +
              'matches on — never a freemail domain, which would grant anyone ' +
              'who can receive mail there.',
            )
            : column(
              `${heading} id`,
              `The id as ${provider} emits it in its groups claim — an object id, ` +
              'not a display name. Anybody in the group is a member of this one, ' +
              "and who that is stays the directory's answer rather than a list " +
              'kept here.',
            ),
          column(
            'Note',
            'Optional on a mapping, and worth writing: a directory group id is ' +
            'usually thirty-six characters that carry no meaning to read, only to ' +
            'match. This is the only place the listing can say which group it is.',
          ),
          column('Expire by', EXPIRE_BY_HELP),
        ],
        bulkRemoveOp: `remove-selected:groups.${name}`,
        kind: SOURCE_GROUP,
        entries: [
          ...mappings.map((index) => matchEntry(root, name, index, provider)),
          matchEntry(root, name, trailingAt, provider, true, seeded !== null),
        ],
        emptyNote: '',
      },
      {
        title: 'People',
        columns: [
          column(
            'Person',
            'An email address, matched against the address the provider reports — ' +
            'or the id it emits in its `subject` claim, which is the durable form: ' +
            'a subject is assigned by the provider and cannot be set by the ' +
            'person it identifies, so it survives a rename and nobody else can ' +
            'claim it. Which of the two a row asks for follows what is stored, ' +
            'and a new one is an address.',
          ),
          column(
            'Note',
            'Optional, and worth writing: a name in a group is one whose reason ' +
            'for being there nobody remembers a year later. It is what an access ' +
            'review reads.',
          ),
          column('Expire by', EXPIRE_BY_HELP),
        ],
        bulkRemoveOp: `remove-selected:groups.${name}`,
        kind: SOURCE_PERSON,
        entries: [
          ...people.map((index) => personEntry(root, name, index)),
          personEntry(root, name, trailingAt + 1, true),
        ],
        emptyNote: '',
      },
    ],
    removeOp: `remove:groups.${name}.provider.${provider}`,
    noun: 'source',
  };
}

function declaredGrow(op: string): AddOp {
  return {
    op,
    label: '',
    nameLabel: null,
    namePattern: null,
    nameHint: null,
    typeLabel: null,
    typeOptions: [],
    // Adding inline always navigates to the new row page
    opensPage: true,
  };
}
