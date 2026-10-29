import {
  KnownGroups,
  checkRepository,
  isConfigPath,
  missingGroups,
  starterConfig,
} from '../../src/dashboard/configurator/quick-setup/repository-check';

const known: KnownGroups = {
  hasGroup: (name) => ['engineering', 'staff'].includes(name),
  suggestGroup: (name) => (name === 'enginering' ? 'engineering' : null),
};

const root = (body: string) => ({ path: '.speicher.yaml', raw: `version: 1\n${body}` });

describe('checking a repository before it is published', () => {
  it('finds it unpublished without a root .speicher.yaml, whatever its folders hold', () => {
    expect(checkRepository([{ path: 'docs/.speicher.yaml', raw: 'version: 1\n' }], known)).toEqual({
      state: 'unpublished',
    });
  });

  it('finds it ready when every group it names exists, and says who reads it', () => {
    expect(
      checkRepository(
        [
          root(
            'access:\n  groups: [engineering, public]\n  users:\n    - email: a@b.test\n      note: x\n      until: 2099-01-01\n',
          ),
        ],
        known,
      ),
    ).toEqual({ state: 'ready', readers: ['engineering', 'public', '1 person'] });
  });

  it('names the groups that do not exist, with the group a typo was meant to be', () => {
    const verdict = checkRepository(
      [
        root('access:\n  groups: [enginering]\n'),
        { path: 'handbook/.speicher.yaml', raw: 'version: 1\naccess:\n  groups: [contractors]\n' },
      ],
      known,
    );
    expect(verdict).toEqual({
      state: 'unknown-groups',
      readers: ['enginering'],
      groups: [
        { name: 'enginering', suggestion: 'engineering', files: ['.speicher.yaml'] },
        { name: 'contractors', suggestion: null, files: ['handbook/.speicher.yaml'] },
      ],
    });
  });

  it('counts a maintainer group as named too', () => {
    const verdict = checkRepository(
      [root('access:\n  groups: [staff]\nmaintainers:\n  groups: [docs-team]\n')],
      known,
    );
    expect(verdict).toMatchObject({ state: 'unknown-groups', groups: [{ name: 'docs-team' }] });
  });

  it('refuses a root file without access, as the sync does', () => {
    expect(checkRepository([root('display:\n  title: Handbook\n')], known)).toMatchObject({
      state: 'invalid',
      file: '.speicher.yaml',
    });
  });

  it('refuses a file that is not YAML, with the validator’s own message', () => {
    const verdict = checkRepository([{ path: '.speicher.yaml', raw: 'access: [\n' }], known);
    expect(verdict.state).toBe('invalid');
  });

  it('knows a .speicher.yaml or .speicher.yml at the root or in a folder, and nothing else', () => {
    expect(['.speicher.yaml', '.speicher.yml', 'docs/.speicher.yaml'].every(isConfigPath)).toBe(
      true,
    );
    expect(['speicher.yaml', 'docs/x.speicher.yaml', '.speicher.yaml.bak'].some(isConfigPath)).toBe(
      false,
    );
  });

  it('offers a starter file the sync takes, granting a group that exists or one to create', () => {
    expect(
      checkRepository([{ path: '.speicher.yaml', raw: starterConfig('staff') }], known),
    ).toEqual({
      state: 'ready',
      readers: ['staff'],
    });
    expect(
      checkRepository([{ path: '.speicher.yaml', raw: starterConfig(null) }], known),
    ).toMatchObject({
      state: 'unknown-groups',
      groups: [{ name: 'readers' }],
    });
  });
});

describe('the groups the checked repositories miss', () => {
  it('lists each once, with every repository that names it', () => {
    const notes = checkRepository([root('access:\n  groups: [contractors, enginering]\n')], known);
    const wiki = checkRepository([root('access:\n  groups: [contractors]\n')], known);
    const ready = checkRepository([root('access:\n  groups: [staff]\n')], known);
    expect(
      missingGroups([
        { repository: 'acme/notes', verdict: notes },
        { repository: 'acme/wiki', verdict: wiki },
        { repository: 'acme/handbook', verdict: ready },
        { repository: 'acme/unread', verdict: null },
      ]),
    ).toEqual([
      { name: 'contractors', suggestion: null, repositories: ['acme/notes', 'acme/wiki'] },
      { name: 'enginering', suggestion: 'engineering', repositories: ['acme/notes'] },
    ]);
  });
});
