import { entraPortalGroupUrl } from '../../../../../auth/directory/graph';

import { scalarString } from '../../document';
import { at, textField } from '../../config-fields';
import type { Field, Obj } from '../../config-fields';
import type { EntryLine } from '../../model';
import { providerFormKind, providerType } from '../../members';

export const EXPIRE_BY_HELP =
  'Optional date the membership expires, written YYYY-MM-DD. For example, 2026-12-31. A date in the past removes the member immediately. Leave empty for no expiry.';

const ID_ELIDE_OVER = 12;
const ID_KEEP = 8;

function elideId(id: string): string {
  return id.length > ID_ELIDE_OVER ? `${id.slice(0, ID_KEEP)}…` : id;
}

export function matchLine(root: Obj, name: string, index: number, elide: boolean): EntryLine {
  const source = (at(root, ['groups', name, index]) ?? {}) as Obj;
  const id = scalarString(source.id);
  const domain = scalarString(source.domain);
  const subject = scalarString(source.subject);
  const email = scalarString(source.email);
  const group = scalarString(source.group);
  if (group) return { label: 'Group', value: group, mark: '' };
  if (id) return { label: 'Group', value: elide ? elideId(id) : id, mark: '' };
  // Domain-only match for magic-link providers
  if (domain) return { label: 'Email domain', value: domain, mark: '' };
  // Person sources match on subject or email
  if (email) return { label: 'Individual email', value: email, mark: '' };
  if (subject) return { label: 'Person', value: elide ? elideId(subject) : subject, mark: '' };
  return { label: '', value: 'not filled in', mark: '' };
}

function matchPlaceholder(root: Obj, provider: string): string {
  switch (providerFormKind(root, provider)) {
    case 'github':
      return 'org/team-slug';
    case 'entra':
      return 'Entra Group UUID';
    default:
      return 'group identifier';
  }
}

/**
 * The Entra portal page of a directory group
 */
export function portalUrlFor(root: Obj, provider: string, groupId: string): string | undefined {
  if (providerFormKind(root, provider) !== 'entra') return undefined;
  const url = entraPortalGroupUrl(groupId.trim());
  return url === '' ? undefined : url;
}

function portalLinkFor(root: Obj, provider: string, groupId: string): string | undefined {
  const url = portalUrlFor(root, provider, groupId);
  return url === undefined ? undefined : `[Open in Entra ID](${url})`;
}

export function matchFields(root: Obj, name: string, index: number, provider: string): Field[] {
  const base = ['groups', name, index];
  const p = (key: string) => `groups.<key>.<index>.${key}`;
  const magicLink = providerType(root, provider) === 'magic-link';
  return [
    // Group id field, not applicable for magic-link providers
    textField(root, [...base, 'id'], p('id'), 'Provider group id', {
      placeholder: matchPlaceholder(root, provider),
      inapplicable: magicLink,
      // Link to Entra portal for this group
      link: portalLinkFor(root, provider, scalarString(at(root, [...base, 'id']))),
    }),
    textField(root, [...base, 'domain'], p('domain'), 'Email domain', {
      // Domain matching only applies to magic-link providers
      placeholder: 'example.com',
      inapplicable: !magicLink,
    }),
  ];
}

export function personFields(root: Obj, name: string, index: number): Field[] {
  const base = ['groups', name, index];
  const p = (key: string) => `groups.<key>.<index>.${key}`;
  const bySubject = scalarString(at(root, [...base, 'subject'])) !== '';

  return [
    // Subject field shown when a subject is already stored
    textField(root, [...base, 'subject'], p('subject'), 'Directory subject', {
      inapplicable: !bySubject,
    }),
    textField(root, [...base, 'email'], p('email'), 'Email address', {
      placeholder: 'alice@example.com',
      inapplicable: bySubject,
    }),
  ];
}

export function sourceNoteFields(root: Obj, name: string, index: number, person: boolean): Field[] {
  const base = ['groups', name, index];
  const p = (key: string) => `groups.<key>.<index>.${key}`;
  // Note and expiry fields shared by both group and person sources
  return [
    textField(root, [...base, 'note'], p('note'), 'Note', {
      placeholder: person ? 'optional note' : 'optional note',
    }),
    textField(root, [...base, 'until'], p('until'), 'Expire by', {
      placeholder: 'YYYY-MM-DD',
      pattern: '\\d{4}-\\d{2}-\\d{2}',
      patternHint: 'A date written YYYY-MM-DD.',
      help: EXPIRE_BY_HELP,
    }),
  ];
}
