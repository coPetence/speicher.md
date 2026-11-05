/**
 * Git remote fetching card
 */

import type { Obj } from '../../config-fields';
import { durationField } from '../../config-fields';
import type { Card } from '../../model';

/**
 * fetchingCard builds the Sync interval card of a plain git remote's page.
 *
 * @param root the configuration document
 * @param id the source's id
 */
export function fetchingCard(root: Obj, id: string): Card {
  const base = ['forges', id];
  const p = (key: string) => `forges.<key>.${key}`;
  return {
    title: 'Sync interval',
    subtitle: 'How often the repositories are checked for changes.',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    items: [
      durationField(root, [...base, 'poll_interval'], p('poll_interval'), 'Poll interval', {
        fallback: '1h',
        help: 'How often speicher.md checks the repositories of this source for new commits. This can be overridden per repository.',
      }),
    ],
  };
}
