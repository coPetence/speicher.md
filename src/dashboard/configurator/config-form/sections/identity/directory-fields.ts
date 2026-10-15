/**
 * The directory lookup of a provider
 */

import type { Field, Obj } from '../../config-fields';
import {
  SECRET_HELP,
  at,
  durationField,
  isEnvPlaceholder,
  secretField,
  selectField,
  textField,
} from '../../config-fields';
import { scalarString } from '../../document';

/**
 * directoryFields builds the fields of a provider's directory lookup.
 *
 * @param root the configuration document
 * @param base the path of the provider in the configuration document
 * @param type the directory the provider is looked up in
 * @param kind the provider's form kind
 */
export function directoryFields(
  root: Obj,
  base: (string | number)[],
  type: 'graph' | 'github',
  kind: string,
): Field[] {
  const d = [...base, 'directory'];
  const p = (key: string) => `auth.providers.<key>.directory.${key}`;
  const shownWith = type === 'github' ? undefined : [...d, 'type'].join('.');

  const copyable = type === 'graph';
  const from = (key: string) => (copyable ? [...base, key].join('.') : undefined);
  const secret = at(root, [...base, 'client_secret']);
  const secretHidden = secret !== undefined && !isEnvPlaceholder(secret);
  const githubInUse = ['app_id', 'private_key'].some(
    (key) => scalarString(at(root, [...d, key])) !== '',
  );

  const credentials: Field[] =
    type === 'github'
      ? [
          textField(root, [...d, 'app_id'], p('app_id'), 'Directory App id', {
            shownWith,
            required: githubInUse,
            help: "The App id of the directory's GitHub App. You can find it under: **Developer settings** → **GitHub Apps**. It needs the organisation permission **Members: Read-only** and must be installed on every organisation that you want to use.",
          }),
          secretField(root, [...d, 'private_key'], p('private_key'), 'Directory private key', {
            shownWith,
            required: githubInUse,
            help: `${SECRET_HELP}\n\nThe App's secret key .pem file.`,
            upload: {
              accept: '.pem,application/x-pem-file',
              content: 'rsa-private-key',
              label: 'Choose .pem…',
              dropLabel: "Drop the App's .pem file here",
            },
          }),
        ]
      : [
          textField(root, [...d, 'tenant_id'], p('tenant_id'), 'Directory tenant id', {
            shownWith,
            sourceToCopyFrom: kind === 'entra' ? from('issuer') : undefined,
          }),
          textField(root, [...d, 'client_id'], p('client_id'), 'Directory client id', {
            shownWith,
            sourceToCopyFrom: from('client_id'),
            help: 'The directory client id is the application (client) id Speicher uses to look up users and groups in Microsoft Graph. The app registration needs the application permission `User.Read.All`.',
          }),
          secretField(
            root,
            [...d, 'client_secret'],
            p('client_secret'),
            'Directory client secret',
            {
              shownWith,
              sourceToCopyFrom: from('client_secret'),
              // When the provider secret is a stored literal, indicate the directory secret is the same
              sourceToCopyFromOnSave: copyable && secretHidden,
              help: SECRET_HELP,
            },
          ),
        ];

  const cacheLifetime = durationField(
    root,
    [...d, 'cache_ttl'],
    p('cache_ttl'),
    'Directory cache lifetime',
    { shownWith, fallback: '1h' },
  );
  if (type === 'github') return [...credentials, cacheLifetime];

  return [
    selectField(root, [...d, 'type'], p('type'), 'Directory lookup', {
      options: [
        { value: '', label: 'Not configured' },
        { value: type, label: type === 'graph' ? 'Microsoft Graph' : 'GitHub' },
      ],
      // TODO check wether this is actually correct
      help: "The directory lookup lets Speicher ask the provider's user directory about the people and groups repositories grant access to. It is used to match a grant by email even when the sign-in name differs from the address, to show how many people a group reaches, and to drop grants for people whose account has been disabled or deleted.",
    }),
    ...credentials,
    cacheLifetime,
  ];
}
