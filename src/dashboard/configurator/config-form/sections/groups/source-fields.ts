import { entraPortalGroupUrl } from '../../../../../auth/directory/graph';

import { scalarString } from '../../document';
import { at, field } from '../../field';
import type { Obj } from '../../field';
import type { EntryLine, Field } from '../../model';
import { providerFormKind, providerType } from '../../members';

/**
 * The controls and lines a source is drawn with, shared by a group's page and its
 * sources page so the two cannot come to draw one source two ways.
 */

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
  if (id) return { label: 'Group', value: elide ? elideId(id) : id, mark: '' };
  // Domain-only match for magic-link providers
  if (domain) return { label: 'Email domain', value: domain, mark: '' };
  // Person sources match on subject or email
  if (email) return { label: 'Person', value: email, mark: '' };
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
 * Build a link to the Entra portal group detail page, if applicable
 */
function portalLinkFor(root: Obj, provider: string, groupId: string): string | undefined {
  if (providerFormKind(root, provider) !== 'entra') return undefined;
  const url = entraPortalGroupUrl(groupId.trim());
  return url === '' ? undefined : `[Who is in it](${url})`;
}

export function matchFields(root: Obj, name: string, index: number, provider: string): Field[] {
  const base = ['groups', name, index];
  const p = (key: string) => `groups.<key>.<index>.${key}`;
  const magicLink = providerType(root, provider) === 'magic-link';
  return [
    // Group id field, not applicable for magic-link providers
    field(root, [...base, 'id'], p('id'), 'Provider group id', 'text', {
      placeholder: matchPlaceholder(root, provider),
      inapplicable: magicLink,
      // Link to Entra portal for this group
      link: portalLinkFor(root, provider, scalarString(at(root, [...base, 'id']))),
    }),
    field(root, [...base, 'domain'], p('domain'), 'Email domain', 'text', {
      // Domain matching only applies to magic-link providers
      placeholder: 'example.com',
      inapplicable: !magicLink,
    }),
  ];
}

/**
 * Carry the provider field for entry templates that need it prefilled
 */
export function trailingCarry(root: Obj, name: string, index: number, trailing: boolean): Field[] {
  if (trailing) return [];
  return [
    field(
      root,
      ['groups', name, index, 'provider'],
      'groups.<key>.<index>.provider',
      'Provider',
      'text',
      {},
    ),
  ];
}

export function personFields(root: Obj, name: string, index: number): Field[] {
  const base = ['groups', name, index];
  const p = (key: string) => `groups.<key>.<index>.${key}`;
  const bySubject = scalarString(at(root, [...base, 'subject'])) !== '';

  return [
    // Subject field shown when a subject is already stored
    field(root, [...base, 'subject'], p('subject'), 'Directory subject', 'text', {
      inapplicable: !bySubject,
    }),
    field(root, [...base, 'email'], p('email'), 'Email address', 'text', {
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
    field(root, [...base, 'note'], p('note'), 'Note', 'text', {
      placeholder: person ? 'optional note' : 'optional note',
    }),
    field(root, [...base, 'until'], p('until'), 'Expire by', 'text', {
      placeholder: 'YYYY-MM-DD',
      pattern: '\\d{4}-\\d{2}-\\d{2}',
      patternHint: 'A date written YYYY-MM-DD.',
    }),
  ];
}
