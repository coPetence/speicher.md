/**
 * The "Who should see this provider?" card on an identity provider's page
 */

import type { Obj } from '../../config-fields';
import { at, choice, linesField } from '../../config-fields';
import type { Card } from '../../model';

/**
 * signInRoutingCard builds the card that decides for which email addresses the sign-in
 * page offers a provider.
 *
 * @param root the configuration document
 * @param id the provider's key
 */
export function signInRoutingCard(root: Obj, id: string): Card {
  const path = ['auth', 'providers', id, 'domains'];
  const domains = at(root, path);
  const routed = Array.isArray(domains) && domains.length > 0;
  return {
    title: 'Who should see this provider?',
    subtitle: '',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    items: [
      choice(
        'Offered for',
        [
          { value: 'everyone', label: 'All email addresses', items: [] },
          {
            value: 'domains',
            label: 'Only selected domains',
            items: [
              linesField(root, path, 'auth.providers.<key>.domains', 'Email domains', {
                help: 'People signing in with an address at one of these domains see this provider on the sign-in page.',
                rows: 3,
              }),
            ],
          },
        ],
        { name: `auth.providers.${id}.routing`, selected: routed ? 'domains' : 'everyone' },
      ),
    ],
  };
}
