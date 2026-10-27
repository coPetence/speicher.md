/**
 * Mail transport settings only; notification settings belong in notifications.ts
 */

import { defaultBrand } from '../../../../config/config.service';
import { defaultMailFrom } from '../../../../notify/mailer';
import type { Obj } from '../config-fields';
import { SECRET_HELP, at, numberField, secretField, textField } from '../config-fields';
import type { SectionSource } from './registry';
import { sectionHead } from './registry';

export function mailSection(root: Obj): SectionSource {
  // Show the default sender as the placeholder
  const brand = at(root, ['brand', 'name']);
  const username = at(root, ['mail', 'username']);
  const sender = defaultMailFrom(
    (typeof brand === 'string' && brand.trim()) || defaultBrand(),
    typeof username === 'string' ? username : undefined,
  );
  return {
    ...sectionHead('mail'),
    blurb:
      'Enter your SMTP settings to send sign-in links and notifications. ' +
      'See the [setup guide](https://docs.speicher.md/configuration/mail-transport).',
    fields: [
      textField(root, ['mail', 'host'], 'mail.host', 'SMTP host', { required: true }),
      numberField(root, ['mail', 'port'], 'mail.port', 'Port', {
        fallback: 587,
      }),
      textField(root, ['mail', 'username'], 'mail.username', 'Username'),
      secretField(root, ['mail', 'password'], 'mail.password', 'Password', {
        help: SECRET_HELP,
      }),
      textField(root, ['mail', 'from'], 'mail.from', 'From', {
        placeholder: `${sender.name} <${sender.address}>`,
        help: 'Enter a sender name and email address, or leave empty to use the default shown above.',
      }),
      textField(root, ['mail', 'reply_to'], 'mail.reply_to', 'Reply-to'),
    ],
    cards: [],
    addOps: [],
  };
}
