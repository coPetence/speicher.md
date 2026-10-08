import type { Obj } from '../../field';
import { field } from '../../field';
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
    title: 'URLs',
    subtitle: "Which names are left out of the URLs of this source's repositories.",
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    fields: [
      field(
        root,
        [...base, 'default_repository_owner'],
        p('default_repository_owner'),
        'Default repository owner',
        'text',
        {
          placeholder: 'acme',
          help: 'The user or organization whose name should be left out of the URL, so its repositories are served at `/<repo>` instead of `/<owner>/<repo>`. Leave it empty to put the owner in every URL.',
        },
      ),
      field(root, [...base, 'primary'], p('primary'), 'Primary', 'boolean', {
        fallback: false,
        help: 'If true, the repositorie name is left out of the URL in the reader, so the source is served at `/` instead of `/<source>`. There can be only one primary source.',
      }),
    ],
  };
}
