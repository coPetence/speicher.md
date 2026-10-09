/**
 * Administrators
 *
 * `admins.users` only: a group is a mapping to a directory group id, a
 * magic-link provider has only a domain, and first boot needs an administrator
 * before any mapping is known to be right. The groups table badges the ones that
 * administer, so this page carries no control over `admins.groups` — every
 * removal from a group's page would otherwise read as an instruction to empty it
 */

import { scalarString } from '../document';
import { at, selectField, textField } from '../config-fields';
import type { Field, Obj } from '../config-fields';
import type { EntryLine, SectionEntry } from '../model';
import { memberSectionId, providerIds, providerMark } from '../members';
import { sectionHead } from './registry';
import type { SectionSource } from './registry';

export function adminsSection(root: Obj): SectionSource {
  const ids = providerIds(root);
  const users = (at(root, ['admins', 'users']) as unknown[]) ?? [];

  return {
    ...sectionHead('admins'),
    blurb:
      'Manage additional administrators who can operate your instance. This does not grant them any content read rights. Administrators can also be added using [Groups](/-/config/groups?q=administrators)',
    fields: [],
    entries: users.map((_, index) => adminUserEntry(root, index, ids)),
    layout: 'table',
    columns: ['Administrator', 'Why'],
    entryNoun: 'administrator',
    cards: [],
    addOps: [
      {
        op: 'add:admins.users',
        label: 'Add an administrator',
        nameLabel: null,
        namePattern: null,
        nameHint: null,
        typeLabel: null,
        typeOptions: [],
        // Navigate to the next available admin index
        opensPage: true,
        href: `/-/config/${memberSectionId('admins', String(users.length))}`,
      },
    ],
  };
}

function adminUserEntry(root: Obj, index: number, ids: string[]): SectionEntry {
  const user = (at(root, ['admins', 'users', index]) ?? {}) as Obj;
  const subject = scalarString(user.subject);
  const email = scalarString(user.email);
  const note = scalarString(user.note);
  const until = scalarString(user.until);
  const provider = scalarString(user.provider);

  const lines: EntryLine[] = [];
  if (note) lines.push({ label: '', value: note, mark: '' });
  // Show expiry date as a line when set
  if (until) lines.push({ label: 'Expires', value: until, mark: '' });

  return {
    href: `/-/config/${memberSectionId('admins', String(index))}`,
    title: subject || email || 'not filled in',
    subtitle: '',
    mark: providerMark(root, provider),
    icon: '',
    // Badge indicating identification by email rather than subject
    badges: !subject && email ? [{ label: 'By address', icon: '' }] : [],
    lines,
    cells: [],
    search: [subject, email, note, provider].filter(Boolean).join(' ').toLowerCase(),
    fields: [],
    carried: adminUserFields(root, index, ids),
    removeOp: `remove:admins.users.${index}`,
    position: -1,
  };
}

export function adminUserSection(root: Obj, index: number): SectionSource {
  return {
    id: memberSectionId('admins', String(index)),
    title: `Administrator ${index + 1}`,
    parent: 'admins',
    blurb:
      'One person, named directly. Fill in the subject **or** the address, never ' +
      'both — a grant naming two identities does not say which one it trusts.',
    fields: adminUserFields(root, index, providerIds(root)),
    entries: [],
    cards: [],
    addOps: [],
    removeOp: `remove:admins.users.${index}`,
    noun: 'administrator',
  };
}

function adminUserFields(root: Obj, index: number, ids: string[]): Field[] {
  const base = ['admins', 'users', index];
  const p = (key: string) => `admins.users.<index>.${key}`;
  return [
    selectField(root, [...base, 'provider'], p('provider'), 'Provider', {
      options: [{ value: '', label: 'Default provider' }].concat(
        ids.map((id) => ({ value: id, label: id })),
      ),
    }),
    textField(root, [...base, 'subject'], p('subject'), 'Subject', {
      help:
        'The provider’s stable id for this person, and the better of the two: an ' +
        'address can be reassigned. Fill in this **or** the address, never both — ' +
        'a grant naming two identities does not say which one it trusts.',
    }),
    textField(root, [...base, 'email'], p('email'), 'Email', {
      help: 'Used instead of a subject. Matched on the provider’s email claim.',
    }),
    textField(root, [...base, 'note'], p('note'), 'Note', {
      help: 'Why this person is here. Read by whoever reviews this list next.',
    }),
    textField(root, [...base, 'until'], p('until'), 'Expires', {
      placeholder: 'YYYY-MM-DD',
      help: 'Optional. An access review date rather than an enforcement mechanism.',
    }),
  ];
}
