/**
 * Git remote fetching card
 */

import type { Obj } from '../../field';
import { field } from '../../field';
import type { Card } from '../../model';

/**
 * fetchingCard builds the Fetching card of a plain git remote's page.
 *
 * @param root the configuration document
 * @param id the source's id
 */
export function fetchingCard(root: Obj, id: string): Card {
  const base = ['forges', id];
  const p = (key: string) => `forges.<key>.${key}`;
  return {
    title: 'Fetching',
    subtitle:
      'How often the repositories are checked for changes, and which SSH servers are trusted.',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    fields: [
      field(root, [...base, 'poll_interval'], p('poll_interval'), 'Poll interval', 'duration', {
        fallback: '1h',
        help: 'The poll interval is how often Speicher checks the repositories of this source for new commits. This can be overridden per repository.',
      }),
      field(root, [...base, 'known_hosts'], p('known_hosts'), 'Known hosts', 'multiline', {
        help: 'The known hosts are the SSH host keys of the servers the `ssh://` repositories of this source are fetched from, one key per line. To find the keys of a server, run `ssh-keyscan git.example.com`. Speicher does not connect to a server whose key is not listed here.',
        rows: 3,
        startsRow: true,
      }),
    ],
  };
}
