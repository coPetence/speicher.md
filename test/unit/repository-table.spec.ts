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
      ['acme/Empty', 'unpublished'],
      ['acme/Ready', 'never-synced'],
    ]);
  });
});
