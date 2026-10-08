/**
 * The mail transport
 *
 * One page over the `mail` block, and nothing else: it is the relay, not who is
 * told what over it — that is `notifications.ts`, whose own block this page must
 * not be able to reach. Transport lives apart from its consumers because magic
 * links are the first of them rather than the owner
 */

import { SECRET_HELP, field } from '../field';
import type { Obj } from '../field';
import { sectionHead } from './registry';
import type { SectionSource } from './registry';

export function mailSection(root: Obj): SectionSource {
  return {
    ...sectionHead('mail'),
    blurb:
      'The relay this instance sends through: magic links, and every notice on ' +
      '[Notifications](/-/config/notifications). Find out more in our ' +
      '[documentation](https://docs.speicher.md/operate/mail)',
    fields: [
      field(root, ['mail', 'host'], 'mail.host', 'SMTP host', 'text'),
      field(root, ['mail', 'port'], 'mail.port', 'Port', 'number', {
        fallback: 587,
      }),
      field(root, ['mail', 'username'], 'mail.username', 'Username', 'text'),
      field(root, ['mail', 'password'], 'mail.password', 'Password', 'secret', {
        help: SECRET_HELP,
      }),
      field(root, ['mail', 'from'], 'mail.from', 'From', 'text', {
        placeholder: 'Docs <docs@example.com>',
      }),
      field(root, ['mail', 'reply_to'], 'mail.reply_to', 'Reply-to', 'text'),
    ],
    cards: [],
    addOps: [],
  };
}
