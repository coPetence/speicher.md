import type { Obj } from '../config-fields';
import { pickListField } from '../config-fields';
import type { SectionSource } from './registry';
import { sectionHead } from './registry';

export function publicSection(root: Obj): SectionSource {
  return {
    ...sectionHead('public'),
    blurb:
      'You can allow repositories to publish content to anonymous (public) readers. Adding a repository here does not publish the content, it just allows the repo to use the `public` grant in its `.speicher.yaml` files. Find out more in our [documentation](TODO:INSERT_DOCS_LINK)',
    fields: [
      pickListField(root, ['public', 'repos'], 'public.repos', 'Public repositories', {
        source: 'repositories',
        addLabel: 'Add repositories',
        searchLabel: 'Search repositories…',
        empty: 'No repository may publish to public readers yet.',
        help: 'A repository listed here is public only when its own .speicher.yaml grants public access. Add a repository here to allow it to use the `public` grant in its .speicher.yaml.',
      }),
    ],
    cards: [],
    addOps: [],
  };
}
