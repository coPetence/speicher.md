/**
 * The Directory card on a GitHub identity provider's page
 */

import type { Obj } from '../../config-fields';
import { at, choice, githubAppLinksItem, githubAppManifest } from '../../config-fields';
import { scalarString } from '../../document';
import { memberSectionId } from '../../members';
import type { Card } from '../../model';
import { directoryFields } from './directory-fields';
import { waitsForProviderApp } from './github-app-card';

const DIRECTORY_APP_NOTE =
  'GitHub will create a GitHub App that can read the members and teams of the organizations it is installed on. Create it on the organization whose teams you grant access to.';

/**
 * githubDirectoryCard builds the card holding the directory lookup of a GitHub provider.
 *
 * @param root the configuration document
 * @param id the provider's key
 * @param kind the provider's form kind
 */
export function githubDirectoryCard(root: Obj, id: string, kind: string): Card {
  const fields = directoryFields(root, ['auth', 'providers', id], 'github', kind);
  const hasDirectoryApp = ['app_id', 'private_key'].some(
    (key) => scalarString(at(root, ['auth', 'providers', id, 'directory', key])) !== '',
  );
  const manifest = githubAppManifest(
    `/-/config/${memberSectionId('identity', id)}/github-directory-app/manifest`,
    '',
    DIRECTORY_APP_NOTE,
    'github-directory-app',
  );
  return waitsForProviderApp(root, id, {
    title: 'GitHub directory lookup (optional)',
    subtitle: '',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    items: !hasDirectoryApp
      ? [
          choice(
            'How the directory App is set up',
            [
              { value: 'create', label: 'Create on GitHub', items: [manifest] },
              { value: 'manual', label: 'Enter manually', items: fields },
            ],
            { name: `auth.providers.${id}.directory.app`, selected: 'create' },
          ),
        ]
      : [
          ...fields,
          githubAppLinksItem({
            lookup: ['auth', 'providers', id, 'directory'],
            baseUrl: scalarString(at(root, ['auth', 'providers', id, 'base_url'])),
          }),
        ],
  });
}
