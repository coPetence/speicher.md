import type { Obj } from '../config-fields';
import { pickListField } from '../config-fields';
import type { SectionSource } from './registry';
import { sectionHead } from './registry';

export function publicSection(root: Obj): SectionSource {
  return {
    ...sectionHead('public'),
    blurb:
      'You can allow repositories to publish content to anonymous (public) readers. Adding a repository here does not publish the content, it just allows the repo to use the `public` grant in its `.speicher.yaml` files. Find out more in our [documentation](https://docs.speicher.md/configuration/public-access)',
    fields: [
      pickListField(root, ['public', 'repos'], 'public.repos', 'Public repositories', {
        source: 'repositories',
        addLabel: 'Add repositories',
        searchLabel: 'Search repositories…',
        empty: 'No repository may publish to public readers yet.',
        unavailable:
          'Only repositories that have been synchronized can be added here. To add a repository or view its sync status, go to the [repositories page](/-/repositories).',
        help: 'A repository listed here is public only when its own .speicher.yaml grants public access. Add a repository here to allow it to use the `public` grant in its .speicher.yaml.',
      }),
    ],
    cards: [],
    addOps: [],
  };
}
