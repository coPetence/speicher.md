import { SYNC_DEFAULTS } from '../../../../config/types';
import type { Obj } from '../config-fields';
import { linesField, textField } from '../config-fields';
import type { SectionSource } from './registry';
import { sectionHead } from './registry';

export function repositoryDefaultsSection(root: Obj): SectionSource {
  return {
    ...sectionHead('defaults'),
    blurb:
      'speicher.md ingests Markdown files and images from a repository. The include and exclude lists below decide which Markdown files become pages. Images are downloaded when a page links to them, unless the exclude list matches them.',
    twoColumns: true,
    fields: [
      textField(
        root,
        ['defaults', 'display', 'cover'],
        'defaults.display.cover',
        'Default cover image path',
        {
          help: 'The path in which speicher.md looks for the default cover image in every repository, relative to the repository root. For example at `assets/cover.png`. A repository or folder that sets its own `display.cover` in `.speicher.yaml` replaces it. Use a PNG, JPEG, WebP, AVIF or GIF image.',
        },
      ),
      linesField(root, ['defaults', 'sync', 'include'], 'defaults.sync.include', 'Include', {
        help: 'The include list selects the Markdown files that speicher.md publishes as pages. Images and other files are downloaded when a page links to them, so they do not need to be listed. Write one pattern per line. It is used for limiting the ingest to part of a repository, for example `docs/**/*.md`. A repository that sets its own `sync.include` in `.speicher.yaml` replaces this list.',
        fallback: SYNC_DEFAULTS.include,
        placeholder: '**/*.md\n**/*.mdx\ndocs/**/*.md',
        rows: 6,
        inColumn: true,
        startsRow: true,
      }),
      linesField(root, ['defaults', 'sync', 'exclude'], 'defaults.sync.exclude', 'Exclude', {
        help: 'The exclude list removes files from the ingest. Write one pattern per line. It is used for leaving out files such as READMEs, changelogs or drafts, for example `**/drafts/**`. A file that matches both lists is excluded. A repository that sets its own `sync.exclude` in `.speicher.yaml` adds to this list and does not replace it, so files excluded here stay excluded in every repository.',
        fallback: SYNC_DEFAULTS.exclude,
        placeholder: '**/README.md\n**/CHANGELOG.md\n**/drafts/**\n**/_*.md\n**/internal/**',
        rows: 6,
        inColumn: true,
      }),
    ],
    cards: [],
    addOps: [],
  };
}
