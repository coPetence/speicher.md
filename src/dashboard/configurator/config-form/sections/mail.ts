/**
 * The mail transport
 *
 * One page over the `mail` block, and nothing else: it is the relay, not who is
 * told what over it — that is `notifications.ts`, whose own block this page must
 * not be able to reach. Transport lives apart from its consumers because magic
 * links are the first of them rather than the owner
 */

import { SECRET_HELP, numberField, secretField, textField } from '../config-fields';
import type { Obj } from '../config-fields';
import { sectionHead } from './registry';
import type { SectionSource } from './registry';

export function mailSection(root: Obj): SectionSource {
  return {
    ...sectionHead('mail'),
    blurb:
      'The relay this instance sends through: magic links, and every notice it sends. ' +
      'Find out more in our ' +
      '[documentation](https://docs.speicher.md/operate/mail)',
    fields: [
      textField(root, ['mail', 'host'], 'mail.host', 'SMTP host'),
      numberField(root, ['mail', 'port'], 'mail.port', 'Port', {
        fallback: 587,
      }),
      textField(root, ['mail', 'username'], 'mail.username', 'Username'),
      secretField(root, ['mail', 'password'], 'mail.password', 'Password', {
        help: SECRET_HELP,
      }),
      textField(root, ['mail', 'from'], 'mail.from', 'From', {
        placeholder: 'Docs <docs@example.com>',
      }),
      textField(root, ['mail', 'reply_to'], 'mail.reply_to', 'Reply-to'),
    ],
    cards: [],
    addOps: [],
  };
}
