/**
 * The GitHub App card on a GitHub source's page: the App's credentials, and the
 * webhook URL to enter in its settings. While the source has no App yet, the card
 * also offers to have GitHub create the App from a manifest
 */

import { webhookPath, webhookUrl } from '../../../../../forge/webhook-url';

import type { CardItem, Obj } from '../../config-fields';
import {
  SECRET_HELP,
  at,
  choice,
  githubAppLinksItem,
  githubAppManifest,
  secretField,
  textField,
} from '../../config-fields';
import { scalarString } from '../../document';
import { memberSectionId } from '../../members';
import type { Card } from '../../model';
import type { WebhookWording } from '../github-webhook';
import { noWebhookSecretNote, webhookNote, webhookUrlItem } from '../github-webhook';

const WEBHOOK: WebhookWording = {
  subject: 'source',
  app: 'your GitHub App',
  without: 'Speicher picks up changes on its regular schedule instead of right away',
  events: '',
  secretLabel: 'Webhook secret',
};

/**
 * appSetupName returns the name of the switch between creating a source's App on GitHub and entering its details manually.
 *
 * @param id the forge's key
 */
export function appSetupName(id: string): string {
  return `forges.${id}.app`;
}

/**
 * hasGithubApp returns whether a GitHub source has an App, which is the case once any of its credentials is set.
 *
 * @param root the configuration document
 * @param id the forge's key
 */
export function hasGithubApp(root: Obj, id: string): boolean {
  return ['app_id', 'private_key', 'webhook_secret'].some(
    (key) => scalarString(at(root, ['forges', id, key])) !== '',
  );
}

/**
 * appCard builds the card holding the credentials of a GitHub App.
 *
 * @param root the configuration document
 * @param id the forge's key
 */
export function appCard(root: Obj, id: string): Card {
  const base = ['forges', id];
  const p = (key: string) => `forges.<key>.${key}`;

  const credentials: CardItem[] = [
    textField(root, [...base, 'app_id'], p('app_id'), 'App id'),
    secretField(root, [...base, 'private_key'], p('private_key'), 'Private key', {
      help: `${SECRET_HELP}\n\nThe App's .pem file can also be chosen with the button or dropped onto the field.`,
      wide: true,
      upload: {
        accept: '.pem,application/x-pem-file',
        content: 'rsa-private-key',
        label: 'Choose .pem…',
        dropLabel: "Drop the App's .pem file here",
      },
    }),
    secretField(root, [...base, 'webhook_secret'], p('webhook_secret'), 'Webhook secret', {
      help: SECRET_HELP,
      startsRow: true,
    }),
    // It sits beside the webhook secret, since both are entered in the same place on GitHub
    webhookUrlItem('Webhook URL', webhookUrl(id), webhookPath(id), WEBHOOK),
  ];

  // Once the source has an App, the card shows only its credentials
  if (hasGithubApp(root, id)) {
    const hasSecret = scalarString(at(root, [...base, 'webhook_secret'])) !== '';
    return {
      title: 'GitHub App',
      subtitle:
        'You can find these values in the settings of your GitHub App, under Developer settings → GitHub Apps.',
      removeOp: null,
      notes: hasSecret ? [] : [noWebhookSecretNote(WEBHOOK)],
      cards: [],
      addOps: [],
      items: [
        ...credentials,
        githubAppLinksItem({
          lookup: base,
          baseUrl: scalarString(at(root, [...base, 'base_url'])),
        }),
      ],
    };
  }

  const manifest = githubAppManifest(
    `/-/config/${memberSectionId('sources', id)}/github-app/manifest`,
    scalarString(at(root, [...base, 'default_repository_owner'])),
    webhookNote(webhookUrl(id) ?? '', scalarString(at(root, [...base, 'base_url'])), WEBHOOK),
  );
  return {
    title: 'GitHub App',
    subtitle: '',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    items: [
      choice(
        'How the GitHub App is set up',
        [
          { value: 'create', label: 'Create on GitHub', items: [manifest] },
          { value: 'manual', label: 'Enter manually', items: credentials },
        ],
        { name: appSetupName(id), selected: 'create' },
      ),
    ],
  };
}
