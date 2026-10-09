/**
 * The GitHub App card on a GitHub source's page: the App's credentials, and the
 * webhook URL to enter in its settings
 */

import { webhookPath, webhookUrl } from '../../../../../forge/webhook-url';

import type { Obj } from '../../config-fields';
import { SECRET_HELP, copyValue, secretField, textField } from '../../config-fields';
import type { Card } from '../../model';

/**
 * appCard builds the card holding the credentials of a GitHub App.
 *
 * @param root the configuration document
 * @param id the forge's key
 */
export function appCard(root: Obj, id: string): Card {
  const base = ['forges', id];
  const p = (key: string) => `forges.<key>.${key}`;
  return {
    title: 'GitHub App',
    subtitle:
      'You can find these values in the settings of your GitHub App, under Developer settings → GitHub Apps.',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    items: [
      textField(root, [...base, 'app_id'], p('app_id'), 'App id'),
      secretField(root, [...base, 'private_key'], p('private_key'), 'Private key', {
        help: `${SECRET_HELP}\n\nThe App's .pem file can also be chosen with the button or dropped onto the field.`,
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
      // Without SPEICHER_PUBLIC_URL only the path is known; if js is enabled, the browser can complete it with its own origin.
      copyValue(
        'Webhook URL',
        webhookUrl(id) ?? webhookPath(id),
        'Enter this as the **Webhook URL** in the settings of your GitHub App. If only a path without a host is shown, put the address of this instance in front of it.',
      ),
    ],
  };
}
