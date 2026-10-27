import type { Obj } from '../../config-fields';
import { booleanField, textField } from '../../config-fields';
import type { Card } from '../../model';

/**
 * urlCard builds the card deciding how the repositories of a source appear in URLs.
 *
 * @param root the configuration document
 * @param id the forge's key
 */
export function urlCard(root: Obj, id: string): Card {
  const base = ['forges', id];
  const p = (key: string) => `forges.<key>.${key}`;
  return {
    title: 'Simpler URLs',
    subtitle: "Which names are left out of the URLs of this source's repositories.",
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    items: [
      textField(
        root,
        [...base, 'default_repository_owner'],
        p('default_repository_owner'),
        'Default repository owner',
        {
          placeholder: 'acme',
          help: 'Enter a user or organization to omit its name from repository URLs: `/<repo>` instead of `/<owner>/<repo>`. Leave blank to keep all owner names.',
        },
      ),
      booleanField(root, [...base, 'primary'], p('primary'), 'Primary', {
        fallback: false,
        help: 'Enable to omit this source’s ID from its repository URLs. Only one source can be primary; the first source is primary by default. Switching the primary source changes existing URLs.',
      }),
    ],
  };
}
