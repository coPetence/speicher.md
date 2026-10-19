/**
 * The Directory card on a GitHub identity provider's page
 */

import { directoryWebhookPath, directoryWebhookUrl } from '../../../../../forge/webhook-url';
import type { Obj } from '../../config-fields';
import { at, choice, githubAppLinksItem, githubAppManifest } from '../../config-fields';
import { scalarString } from '../../document';
import { memberSectionId } from '../../members';
import type { Card } from '../../model';
import type { WebhookWording } from '../github-webhook';
import { noWebhookSecretNote, webhookNote, webhookUrlItem } from '../github-webhook';
import { directoryFields } from './directory-fields';
import { waitsForProviderApp } from './github-app-card';

const DIRECTORY_APP_NOTE =
  'GitHub will create a GitHub App that can read the members and teams of the organizations it is installed on. Create it on the organization whose teams you grant access to.';

const WEBHOOK: WebhookWording = {
  subject: 'directory',
  app: 'the directory App',
  without: 'a change to a team takes effect after the cache time of the directory',
  events: 'the Membership, Team and Organization events',
  secretLabel: 'Directory webhook secret',
};

/**
 * githubDirectoryCard builds the card holding the directory lookup of a GitHub provider.
 *
 * @param root the configuration document
 * @param id the provider's key
 * @param kind the provider's form kind
 */
export function githubDirectoryCard(root: Obj, id: string, kind: string): Card {
  const base = ['auth', 'providers', id];
  const fields = directoryFields(root, base, 'github', kind);
  const directoryValue = (key: string) => scalarString(at(root, [...base, 'directory', key]));
  const hasDirectoryApp = ['app_id', 'private_key'].some((key) => directoryValue(key) !== '');
  const baseUrl = scalarString(at(root, [...base, 'base_url']));

  const note = webhookNote(directoryWebhookUrl(id) ?? '', baseUrl, WEBHOOK);
  const manifest = githubAppManifest(
    `/-/config/${memberSectionId('identity', id)}/github-directory-app/manifest`,
    '',
    note ? `${DIRECTORY_APP_NOTE}\n\n${note}` : DIRECTORY_APP_NOTE,
    'github-directory-app',
  );
  return waitsForProviderApp(root, id, {
    title: 'GitHub directory lookup (optional)',
    subtitle: '',
    removeOp: null,
    notes:
      hasDirectoryApp && directoryValue('webhook_secret') === ''
        ? [noWebhookSecretNote(WEBHOOK)]
        : [],
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
          webhookUrlItem(
            'Directory webhook URL',
            directoryWebhookUrl(id),
            directoryWebhookPath(id),
            WEBHOOK,
          ),
          githubAppLinksItem({ lookup: [...base, 'directory'], baseUrl }),
        ],
  });
}
