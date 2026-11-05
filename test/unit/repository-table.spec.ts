import { repositoryTable } from '../../src/dashboard/setup/repository-table';
import type { RepoStatus } from '../../src/dashboard/status/status.types';

const synced = (slug: string, state: RepoStatus['state']): RepoStatus => ({
  namespace: 'acme',
  slug,
  forge_key: 'gh',
  forge_type: 'github',
  last_sha: null,
  last_run_at: null,
  last_status: 'ok',
  last_error: null,
  poll_interval_ms: null,
  documents: 0,
  stale: false,
  activity: null,
  state,
});

describe('the table of the repository step', () => {
  const keys = (rows: ReturnType<typeof repositoryTable>) => rows.map((row) => row.key);

  it('lists the repositories with a file first, whatever their sync says, each group by name', () => {
    const rows = repositoryTable(
      [
        synced('zebra', 'ok'),
        synced('alpha', 'unpublished'),
        synced('broken', 'failed'),
        synced('beta', 'unpublished'),
      ],
      [],
      new Map(),
      new Set(),
    );

    expect(keys(rows)).toEqual(['acme/broken', 'acme/zebra', 'acme/alpha', 'acme/beta']);
  });

  it('moves a repository up once a check finds its file, before the next sync', () => {
    const rows = repositoryTable(
      [synced('alpha', 'unpublished'), synced('beta', 'ok')],
      [],
      new Map([
        [
          'gh',
          [
            {
              name: 'acme/alpha',
              href: 'https://github.com/acme/alpha',
              state: 'ready' as const,
              text: 'Readable by staff',
              readers: 'staff',
            },
          ],
        ],
      ]),
      new Set(),
    );

    expect(keys(rows)).toEqual(['acme/alpha', 'acme/beta']);
  });

  it('is in the same order whether the rows came from a sync or from a check', () => {
    const missing = (name: string) => ({
      name,
      href: `https://github.com/${name}`,
      state: 'unpublished' as const,
      text: 'Not published: it has no `.speicher.yaml` yet',
    });
    const fromSync = repositoryTable(
      [synced('handbook', 'ok'), synced('alpha', 'unpublished')],
      [],
      new Map(),
      new Set(),
    );
    const fromCheck = repositoryTable(
      [synced('handbook', 'ok')],
      [],
      new Map([['gh', [missing('acme/alpha')]]]),
      new Set(),
    );

    expect(keys(fromCheck)).toEqual(keys(fromSync));
  });

  it('is one row per repository, whatever case GitHub spells its name in', () => {
    const rows = repositoryTable(
      [synced('handbook', 'ok'), synced('wiki', 'unpublished')],
      ['acme/handbook'],
      new Map([
        [
          'gh',
          [
            {
              name: 'acme/Handbook',
              href: 'https://github.com/acme/Handbook',
              state: 'ready' as const,
              text: 'Readable by staff',
              readers: 'staff',
              edit_href: 'https://github.com/acme/Handbook/edit/main/.speicher.yaml',
            },
            {
              name: 'acme/Wiki',
              href: 'https://github.com/acme/Wiki',
              state: 'unpublished' as const,
              text: '',
              create_href: '/-/config/sources/gh/config-file?repository=acme%2FWiki&branch=main',
            },
          ],
        ],
      ]),
      new Set(),
    );

    expect(rows.map((row) => [row.key, row.name])).toEqual([
      ['acme/handbook', 'acme/Handbook'],
      ['acme/wiki', 'acme/Wiki'],
    ]);
    // What the sync knows stays, what the check knows is added
    expect(rows[0]).toMatchObject({
      readable: true,
      sync: { state: 'ok' },
      status_href: '/-/status/acme/handbook',
      access: { level: 'ok', text: 'staff' },
      file: {
        label: 'present',
        edit_href: 'https://github.com/acme/Handbook/edit/main/.speicher.yaml',
      },
    });
    expect(rows[1].file.create_href).toContain('config-file');
  });

  it('is one row for a name the sync slugs, e.g. a dot in it', () => {
    const rows = repositoryTable(
      [{ ...synced('speicher-md', 'failed'), namespace: 'coPetence' }],
      [],
      new Map([
        [
          'gh',
          [
            {
              name: 'coPetence/speicher.md',
              href: '',
              state: 'ready' as const,
              text: '',
              groups: ['public'],
            },
          ],
        ],
      ]),
      new Set(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'copetence/speicher-md',
      name: 'coPetence/speicher.md',
      synced: { namespace: 'coPetence', slug: 'speicher-md' },
      sync: { state: 'failed' },
      groups: ['public'],
    });
  });

  it('says how far a repository no sync has found yet is, as the sync status would', () => {
    const rows = repositoryTable(
      [],
      [],
      new Map([
        [
          'gh',
          [
            { name: 'acme/Ready', href: '', state: 'ready' as const, text: '' },
            { name: 'acme/Empty', href: '', state: 'unpublished' as const, text: '' },
          ],
        ],
      ]),
      new Set(),
    );
    expect(rows.map((row) => [row.name, row.sync.state])).toEqual([
      ['acme/Ready', 'never-synced'],
      ['acme/Empty', 'unpublished'],
    ]);
  });
});
