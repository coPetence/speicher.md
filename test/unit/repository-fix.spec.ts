import type { SourceCheck } from '../../src/dashboard/configurator/quick-setup/source-check';
import { FixInput, nextFix } from '../../src/dashboard/setup/repository-fix';
import type { RepositoryTableRow } from '../../src/dashboard/setup/repository-table';

const me = { name: 'ferdinand.duschka@copetence.de', provider: 'GitHub', groups: ['staff'] };

const row = (name: string, overrides: Partial<RepositoryTableRow> = {}): RepositoryTableRow => ({
  key: name,
  name,
  href: `https://github.com/${name}`,
  status_href: null,
  synced: { namespace: name.split('/')[0], slug: name.split('/')[1] },
  source: 'gh',
  file: { level: 'idle', label: 'missing' },
  access: null,
  groups: null,
  sync: { state: 'never-synced', activity: null, last_error: null },
  readable: false,
  ...overrides,
});

const checked = (overrides: Partial<SourceCheck> = {}): Map<string, SourceCheck> =>
  new Map([
    [
      'gh',
      {
        repositories: [],
        more: false,
        missing: [],
        installation_href: 'https://github.com/organizations/acme/settings/installations/5',
        ...overrides,
      },
    ],
  ]);

const input = (overrides: Partial<FixInput> = {}): FixInput => ({
  finished: false,
  me,
  readable: false,
  sources: ['gh'],
  checks: checked(),
  discovering: [],
  rows: [],
  allowsPublic: () => false,
  ...overrides,
});

describe('the next step of the repositories page', () => {
  it('is none once the administrator can read a repository', () => {
    expect(nextFix(input({ readable: true }))).toBeNull();
  });

  it('asks for the steps before the repositories first, one at a time', () => {
    expect(nextFix(input({ me: null }))?.id).toBe('administrator');
    expect(nextFix(input({ me: { ...me, groups: [] } }))?.id).toBe('group');
    expect(nextFix(input({ sources: [], checks: new Map() }))?.id).toBe('source');
  });

  it('says it is checking while the checks of the GitHub sources have not run', () => {
    expect(nextFix(input({ checks: null }))).toMatchObject({ id: 'checking', waits: true });
  });

  it('asks to install the App before anything about the repositories', () => {
    const fix = nextFix(
      input({
        checks: checked({
          problem: {
            text: 'The App is not installed on **acme** yet.',
            href: 'https://github.com/apps/speicher-acme/installations/new',
            label: 'Install on GitHub',
          },
        }),
        rows: [row('acme/handbook')],
      }),
    );
    expect(fix).toMatchObject({
      id: 'install',
      action: { label: 'Install on GitHub', external: true },
    });
  });

  it('leads to the installation when the App reads no repository', () => {
    expect(nextFix(input())).toMatchObject({
      id: 'no-repository',
      action: { href: 'https://github.com/organizations/acme/settings/installations/5' },
    });
  });

  it('opens the modal of a new file in place when one repository can have it', () => {
    const fix = nextFix(
      input({
        checks: checked({ repositories: [] }),
        rows: [
          row('acme/handbook', {
            file: {
              level: 'idle',
              label: 'missing',
              create_href: '/-/repositories?config_file=gh',
              create_action: '/-/config/sources/gh/config-file?repository=acme%2Fhandbook',
            },
          }),
        ],
      }),
    );
    expect(fix?.id).toBe('no-file');
    expect(fix?.action?.create).toEqual({
      action: '/-/config/sources/gh/config-file?repository=acme%2Fhandbook',
      repository: 'acme/handbook',
    });
    expect(fix?.text).toContain('grants `staff` read access');
  });

  it('asks to rename a config file named without its dot, before offering a new one', () => {
    const fix = nextFix(
      input({
        rows: [
          row('acme/wiki', {
            file: {
              level: 'warn',
              label: 'misnamed',
              misnamed: 'speicher.yaml',
              edit_href: 'https://github.com/acme/wiki/edit/main/speicher.yaml',
            },
          }),
          row('acme/handbook', {
            file: {
              level: 'idle',
              label: 'missing',
              create_href: '/-/repositories?config_file=gh',
              create_action: '/-/config/sources/gh/config-file?repository=acme%2Fhandbook',
            },
          }),
        ],
      }),
    );
    expect(fix).toMatchObject({
      id: 'misnamed',
      title: 'Rename `speicher.yaml` in acme/wiki',
      text: "`speicher.yaml` should be the repository's `.speicher.yaml`, but it is named incorrectly. Rename it to `.speicher.yaml`, with a leading dot.",
      action: {
        label: 'Rename on GitHub',
        href: 'https://github.com/acme/wiki/edit/main/speicher.yaml',
        external: true,
      },
    });
  });

  it('gives a source without a check the file to commit', () => {
    const fix = nextFix(
      input({
        sources: ['docs'],
        checks: new Map(),
        rows: [
          row('handbook/handbook', {
            source: 'docs',
            file: { level: 'idle', label: 'missing', copy: true },
          }),
        ],
      }),
    );
    expect(fix).toMatchObject({ id: 'no-file', snippet: true });
    expect(fix?.action).toBeUndefined();
  });

  it('prefers a repository that grants the administrator, over one that grants others', () => {
    const fix = nextFix(
      input({
        rows: [
          row('acme/handbook', { file: { level: 'ok', label: 'present' }, groups: ['ops'] }),
          row('acme/wiki', { file: { level: 'ok', label: 'present' }, groups: ['staff'] }),
        ],
      }),
    );
    expect(fix).toMatchObject({
      id: 'syncing',
      waits: true,
      title: 'speicher.md is syncing acme/wiki',
    });
  });

  it("asks to grant one of the administrator's groups, naming who the file grants", () => {
    const fix = nextFix(
      input({
        rows: [
          row('acme/handbook', {
            file: {
              level: 'ok',
              label: 'present',
              edit_href: 'https://github.com/acme/handbook/edit/main/.speicher.yaml',
            },
            groups: ['ops'],
          }),
        ],
      }),
    );
    expect(fix?.id).toBe('no-grant');
    expect(fix?.text).toBe(
      'Its `.speicher.yaml` lets `ops` read it, but you are in `staff`. Add `staff` to the groups under `access`.',
    );
    expect(fix?.action).toMatchObject({ label: 'Edit on GitHub', external: true });
  });

  it('asks to list a repository that grants public among the public repositories', () => {
    const rows = [
      row('coPetence/speicher.md', {
        file: { level: 'ok', label: 'present' },
        groups: ['public'],
      }),
    ];
    const fix = nextFix(input({ rows }));
    expect(fix).toMatchObject({
      id: 'public',
      title: 'Allow public access to coPetence/speicher.md',
      detail: 'Repository: `copetence/speicher-md`',
      action: {
        label: 'Add to public repositories',
        href: '/-/config/public?pick=copetence%2Fspeicher-md',
      },
    });
    expect(fix?.action?.disabled).toBeUndefined();

    // Listed: everyone reads it, the administrator too, once it is synced
    expect(nextFix(input({ rows, allowsPublic: () => true }))).toMatchObject({
      id: 'syncing',
      text: 'Its `.speicher.yaml` grants everyone read access. You can read it once the sync is done.',
    });
  });

  it('offers to list a repository only once it is synchronized, and to synchronize it', () => {
    const rows = [
      row('coPetence/speicher.md', {
        file: { level: 'ok', label: 'present' },
        groups: ['public'],
        synced: null,
      }),
    ];
    expect(nextFix(input({ rows }))).toMatchObject({
      id: 'public',
      action: {
        label: 'Add to public repositories',
        disabled: 'You can add the repository once it is synchronized.',
      },
      secondary: { label: 'Synchronize now', href: '/-/discover', post: { back: 'repositories' } },
    });
  });

  it('synchronizes a repository it grants the administrator before waiting for its sync', () => {
    const rows = [
      row('acme/wiki', {
        file: { level: 'ok', label: 'present' },
        groups: ['staff'],
        synced: null,
      }),
    ];
    expect(nextFix(input({ rows }))).toMatchObject({
      id: 'discover',
      action: { label: 'Synchronize now' },
    });
    expect(nextFix(input({ rows, discovering: ['gh'] }))).toMatchObject({
      id: 'discovering',
      waits: true,
    });
  });

  it('says why a sync failed rather than waiting for it', () => {
    const fix = nextFix(
      input({
        rows: [
          row('acme/wiki', {
            file: { level: 'ok', label: 'present' },
            groups: ['staff'],
            status_href: '/-/status/acme/wiki',
            sync: { state: 'failed', activity: null, last_error: 'clone failed' },
          }),
        ],
      }),
    );
    // The error on its own line, and the sync to run again once it is fixed
    expect(fix).toMatchObject({
      id: 'sync-failed',
      detail: 'clone failed',
      action: {
        label: 'Sync again',
        href: '/-/sync',
        post: { namespace: 'acme', slug: 'wiki', back: 'repositories' },
      },
    });
  });

  it('asks to allow public access before a sync that fails on it, though the file grants the administrator', () => {
    const rows = [
      row('TimMolitor/TestSpeicher', {
        file: { level: 'ok', label: 'present' },
        groups: ['staff', 'public'],
        sync: { state: 'failed', activity: null, last_error: 'public is not enabled' },
      }),
    ];
    expect(nextFix(input({ rows }))).toMatchObject({
      id: 'public',
      action: { href: '/-/config/public?pick=timmolitor%2Ftestspeicher' },
    });

    // Allowed: what is left is the sync
    expect(nextFix(input({ rows, allowsPublic: () => true }))?.id).toBe('sync-failed');
  });

  it('only reports the content sources after the setup', () => {
    expect(nextFix(input({ finished: true, me: { ...me, groups: [] } }))?.id).toBe('no-repository');
    expect(
      nextFix(
        input({
          finished: true,
          rows: [row('acme/handbook')],
          checks: checked({
            repositories: [{ name: 'acme/handbook', href: '', state: 'unpublished', text: '' }],
          }),
        }),
      ),
    ).toBeNull();
  });
});
