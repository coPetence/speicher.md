import type { Obj } from '../config-fields';
import { booleanField, linesField, textField } from '../config-fields';
import type { SectionSource } from './registry';
import { sectionHead } from './registry';

export function repositoryDefaultsSection(root: Obj): SectionSource {
  return {
    ...sectionHead('defaults'),
    blurb:
      'Specifies what is being included and excluded from the repository. Check out the documentation for a deeper understanding [link]',
    fields: [
      linesField(root, ['defaults', 'sync', 'include'], 'defaults.sync.include', 'Include', {
        help: 'Globs, one per line. Defaults to every Markdown file.',
        rows: 4,
      }),
      linesField(root, ['defaults', 'sync', 'exclude'], 'defaults.sync.exclude', 'Exclude', {
        help: 'Globs, one per line. Defaults to every Markdown file.',
        rows: 4,
      }),
      textField(
        root,
        ['defaults', 'display', 'cover'],
        'defaults.display.cover',
        'Default cover image',
        {
          help: 'Cover image to be shown at the top of an article and on listing pages for folders or repositories. Can overwritten per folder. No SVGs allowed for security reasons.',
        },
      ),
      booleanField(
        root,
        ['defaults', 'retrieval', 'indexable'],
        'defaults.retrieval.indexable',
        'Indexable by default',
        {
          fallback: true,
          help: 'Whether pages are returned by search and accessible through MCP',
        },
      ),
    ],
    cards: [],
    addOps: [],
  };
}
