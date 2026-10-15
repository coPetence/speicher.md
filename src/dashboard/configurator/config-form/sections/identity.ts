/**
 * Identity: the providers a reader signs in through
 *
 * One page per provider, each owning that provider and no collection. A
 * provider's kind is not a setting — `entra` is a virtual kind recognised by the
 * shape of its issuer (`providerFormKind`), which is why the form asks the
 * document rather than reading `type`
 */

import { scalarString } from '../document';
import type { Field, Obj } from '../config-fields';
import {
  SECRET_HELP,
  at,
  booleanField,
  durationField,
  entraTenantField,
  linesField,
  secretField,
  textField,
  urlField,
} from '../config-fields';
import {
  ENTRA_TENANT_HINT,
  ENTRA_TENANT_PATTERN,
  PROVIDER_KINDS,
  SHORT_ID,
  SHORT_ID_HINT,
  freeMemberId,
  kindOf,
  memberSectionId,
  nounOf,
  providerFormKind,
  providerIds,
  type KindHint,
} from '../members';
import { unavailableOption } from '../model';
import type { Option, SectionEntry } from '../model';
import { directoryFields } from './identity/directory-fields';
import { githubAppCard } from './identity/github-app-card';
import { githubDirectoryCard } from './identity/github-directory-card';
import type { SectionSource } from './registry';
import { sectionHead } from './registry';

export function identitySection(root: Obj): SectionSource {
  const ids = providerIds(root);
  // Magic-link providers need a mail transport to be usable
  const hasMailTransport = at(root, ['mail']) !== undefined;

  return {
    ...sectionHead('identity'),
    blurb:
      'Manage your identity providers and configure single sign-on. Find out more in our [documentation](https://docs.speicher.md/access/identity)',
    fields: [],
    entries: ids.map((id) => providerEntry(root, id, ids.length > 1)),
    layout: 'tiles',
    entryNoun: nounOf('identity'),
    cards: [],
    addOps: [
      {
        op: 'add:auth.providers',
        label: 'Add a provider',
        nameLabel: 'Short id',
        namePattern: SHORT_ID.source.slice(1, -1),
        nameHint: SHORT_ID_HINT,
        typeLabel: 'Kind',
        // Provider kind options with a suggested id
        typeOptions: PROVIDER_KINDS.map((kind) => {
          const option: Option = {
            value: kind.value,
            label: kind.label,
            suggest: freeMemberId(ids, kind.value),
            mark: kind.mark,
          };
          // Magic-link is unavailable when no mail transport is configured
          return kind.value === 'magic-link' && !hasMailTransport
            ? unavailableOption(
                option,
                'Magic link sends a sign-in link by email, and this instance has no ' +
                  'mail transport. Configure it under [Mail transport](/-/config/mail), ' +
                  'then add the provider.',
              )
            : option;
        }),
        // Navigates to the new provider's detail page
        opensPage: true,
      },
    ],
  };
}

function providerEntry(root: Obj, id: string, removable: boolean): SectionEntry {
  // Determine the effective form kind for mark and subtitle
  const kind = providerFormKind(root, id);
  const named = scalarString(at(root, ['auth', 'providers', id, 'display_name'])).trim();
  return {
    href: `/-/config/${memberSectionId('identity', id)}`,
    // Title is always the short id regardless of display name
    title: id,
    // Show display name if set, otherwise the provider kind label
    subtitle: named || (kindOf(kind)?.label ?? kind),
    mark: kindOf(kind)?.mark ?? '',
    icon: '',
    // Default provider badge
    badges: at(root, ['auth', 'default_provider']) === id ? [{ label: 'Default', icon: '' }] : [],
    lines: [],
    cells: [],
    search: `${id} ${kindOf(kind)?.label ?? kind}`.toLowerCase(),
    fields: [],
    carried: [],
    // The last provider cannot be removed
    removeOp: removable ? `remove:auth.providers.${id}` : null,
    position: -1,
  };
}

function providerBlurb(kind: string): string {
  if (kind === 'entra') {
    return 'Microsoft Entra ID (based on OpenID Connect). For a B2C tenant or a national cloud use the OpenID Connect provider. Find out more in our [documentation](https://docs.speicher.md/access/identity/entra)';
  }
  if (kind === 'magic-link') {
    return 'A signed link, sent by email. It needs the mail transport configured [here](/-/config/mail). Find out more in our [documentation](https://docs.speicher.md/access/identity/magic-link)';
  }
  if (kind === 'github') {
    // Team membership resolves through the directory below
    return 'GitHub as an identity provider. Team membership resolves through the directory below. Find out more in our [documentation](https://docs.speicher.md/access/identity/github)';
  }
  return (
    'OpenID Connect. Issuer, audience and key source are pinned together, which is ' +
    'what stops a token minted for another client being accepted here. Find out more in our [documentation](https://docs.speicher.md/access/identity/oidc)'
  );
}

export function providerSection(root: Obj, id: string, hint?: KindHint): SectionSource {
  const kind = providerFormKind(root, id, hint);
  const base = ['auth', 'providers', id];
  const p = (key: string) => `auth.providers.<key>.${key}`;

  const fields: Field[] = [
    textField(root, [...base, 'display_name'], p('display_name'), 'Display name', {
      placeholder: id,
      help: 'The name is shown to readers signing in',
    }),
  ];

  if (kind === 'entra') {
    fields.push(
      entraTenantField(root, [...base, 'issuer'], p('issuer'), 'Directory (tenant) id', {
        placeholder: '00000000-0000-0000-0000-000000000000',
        pattern: ENTRA_TENANT_PATTERN,
        patternHint: ENTRA_TENANT_HINT,
        help:
          'The directory (tenant) id identifies the Microsoft Entra directory whose ' +
          'accounts may sign in. You find it in the Azure portal ' +
          'under **Microsoft Entra ID** → **Overview**, as **Tenant ID**.',
      }),
      ...oidcFields(root, base, p, 'entra'),
    );
    fields.push(...directoryFields(root, base, 'graph', kind));
  } else if (kind === 'oidc') {
    fields.push(
      textField(root, [...base, 'issuer'], p('issuer'), 'Issuer URL', {
        placeholder: 'https://auth.example.com/realms/<realm>',
        help:
          'The issuer URL identifies the OpenID Connect server people sign in with, for ' +
          'example `https://auth.example.com/realms/<realm>` for a Keycloak realm.',
      }),
      ...oidcFields(root, base, p, 'oidc'),
    );
    fields.push(...directoryFields(root, base, 'graph', kind));
  } else if (kind === 'magic-link') {
    fields.push(
      durationField(root, [...base, 'token_ttl'], p('token_ttl'), 'Link lifetime', {
        fallback: '15m',
      }),
      durationField(root, [...base, 'session_ttl'], p('session_ttl'), 'Session lifetime', {
        fallback: '30d',
      }),
      booleanField(root, [...base, 'same_browser'], p('same_browser'), 'Same browser only', {
        fallback: true,
        help:
          'The link only completes in the browser that asked for it. Off means a ' +
          'forwarded mail is a working credential.',
      }),
    );
  } else {
    fields.push(
      // GitHub Enterprise base URL, only relevant for self-hosted installations
      urlField(root, [...base, 'base_url'], p('base_url'), 'Base URL', {
        placeholder: 'https://github.example.com',
        help: 'GitHub Enterprise only. Leave blank for github.com.',
        advanced: true,
      }),
      durationField(root, [...base, 'session_ttl'], p('session_ttl'), 'Session lifetime', {
        fallback: '8h',
        help: 'How long a sign-in stays valid before the person has to sign in again. If you remove someone from a team it needs a new session to take effect. If you need fast team removal times, keep this low.',
        advanced: true,
      }),
    );
  }

  fields.push(
    // Boolean field using the provider id as trueValue
    booleanField(root, ['auth', 'default_provider'], 'auth.default_provider', 'Default provider', {
      trueValue: id,
      help: "The default provider is used for grants that name a person without naming a provider, for example `{ email: example@copetence.de }` under `access.users` in a repository's `.speicher.yaml`. If only one provider is configured, this provider will be automatically set as the default.",
      trailing: kind === 'github',
    }),
  );

  return {
    id: memberSectionId('identity', id),
    title: id,
    parent: 'identity',
    cards: kind === 'github' ? [githubAppCard(root, id), githubDirectoryCard(root, id, kind)] : [],
    mark: kindOf(kind)?.mark ?? '',
    // The last remaining provider cannot be removed
    removeOp: providerIds(root).length > 1 ? `remove:auth.providers.${id}` : null,
    renameOp: `rename:auth.providers.${id}`,
    renamePattern: SHORT_ID.source.slice(1, -1),
    renameHint: SHORT_ID_HINT,
    noun: nounOf('identity'),
    blurb: providerBlurb(kind),
    fields,
    entries: [],
    addOps: [],
  };
}

function oidcFields(
  root: Obj,
  base: (string | number)[],
  p: (key: string) => string,
  kind: 'oidc' | 'entra',
): Field[] {
  const entra = kind === 'entra';
  return [
    textField(root, [...base, 'client_id'], p('client_id'), 'Client id', {
      help: entra
        ? 'The application (client) id of the app registration. You can find it in the Azure portal under **Microsoft Entra ID** → **App registrations** → your app → **Overview**.'
        : '',
    }),
    secretField(root, [...base, 'client_secret'], p('client_secret'), 'Client secret', {
      help: SECRET_HELP,
    }),
    textField(root, [...base, 'subject_claim'], p('subject_claim'), 'Subject claim', {
      fallback: 'sub',
      placeholder: 'sub',
      help: "The subject claim is the field in the sign-in token that holds the id of the person signing in. Most providers send it as `sub`, so this probably doesn't need to be changed. When using Microsoft Entra ID, the subject claim is `oid`.",
    }),
    textField(root, [...base, 'groups_claim'], p('groups_claim'), 'Groups claim', {
      fallback: 'groups',
      placeholder: 'groups',
      help:
        'The groups claim is the field in the sign-in token that lists the groups of the ' +
        'person signing in. Most providers send it as `groups`, but only once it has been ' +
        'turned on. In Microsoft Entra ID this is under **App registrations** → your app → ' +
        '**Token configuration** → **Add groups claim**. Learn more about ' +
        // TODO: docs/02-access/04-groups.md needs a section on providers that cannot send
        // usable groups. Public identity providers such as Google put every user into one
        // big pool, so access control through groups does not work there. It should go
        // into detail about the alternatives: access by email or subject, i.e. a group
        // defined in Speicher itself that names its people.
        '[groups](https://docs.speicher.md/access/groups).',
    }),
    textField(root, [...base, 'email_claim'], p('email_claim'), 'Email claim', {
      fallback: 'email',
      placeholder: 'email',
      help:
        'The email claim is the field in the sign-in token that holds the email address of ' +
        'the person signing in. Most providers send it as `email`. Microsoft Entra ID sends ' +
        'the sign-in name as `preferred_username`, which usually looks like the email ' +
        'address. To use the actual email address instead, add `email` as an optional claim ' +
        'under **App registrations** → your app → **Token configuration** → **Add optional ' +
        'claim**, and set this to `email`.',
    }),
    linesField(root, [...base, 'domains'], p('domains'), 'Email domains', {
      help: 'The email domains are used for home-realm discovery: when several providers are configured, they decide which one signs in people with an address at these domains. For example, with `copetence.de` listed here, `example@copetence.de` is sent straight to this provider, even if another provider could sign in the same person. Please enter each domain on its own line.',
      rows: 3,
    }),
    durationField(root, [...base, 'session_ttl'], p('session_ttl'), 'Session lifetime', {
      fallback: '8h',
      help:
        'The session lifetime is how long a sign-in stays valid before the person has to ' +
        'sign in again, counted from the sign-in. It also decides how long a removed group ' +
        'membership keeps working: groups are read from the sign-in token, so the removal ' +
        'only takes effect at the next sign-in.',
    }),
  ];
}
