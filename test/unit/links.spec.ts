import {
  buildNameIndex,
  nameKeysFor,
  pageCandidates,
  parseRepoTarget,
  RepoAddressPolicy,
  repoTargetUrl,
} from '../../src/ingest/links';

const POLICY: RepoAddressPolicy = {
  primaryForgeId: 'gh',
  defaultRepositoryOwnerSlug: (forge) => (forge === 'gh' ? 'copetence' : undefined),
};

describe('parseRepoTarget', () => {
  it('is not consulted for anything that is not an address', () => {
    expect(parseRepoTarget('../guide.md')).toBeNull();
    expect(parseRepoTarget('/root.md')).toBeNull();
    expect(parseRepoTarget('mailto:a@b.test')).toBeNull();
  });

  it('reads the scheme off the segment count, never off the path', () => {
    expect(parseRepoTarget('@kb-dev-tools:dotenvx')).toEqual({
      forgeKey: null,
      namespace: null,
      slug: 'kb-dev-tools',
      path: 'dotenvx',
    });
    expect(parseRepoTarget('@northwind-engineering/specs:tolerances')).toEqual({
      forgeKey: null,
      namespace: 'northwind-engineering',
      slug: 'specs',
      path: 'tolerances',
    });
    expect(parseRepoTarget('@gitlab/acme/docs:a/b')).toEqual({
      forgeKey: 'gitlab',
      namespace: 'acme',
      slug: 'docs',
      path: 'a/b',
    });
  });

  it('reads a path-shaped address as an address, which is the whole point of the colon', () => {
    expect(parseRepoTarget('@kb-dev-tools/dotenvx')).toEqual({
      forgeKey: null,
      namespace: 'kb-dev-tools',
      slug: 'dotenvx',
      path: '',
    });
  });

  it('addresses a repository landing page with no path at all', () => {
    expect(parseRepoTarget('@specs:')).toMatchObject({ slug: 'specs', path: '' });
    expect(parseRepoTarget('@specs')).toMatchObject({ slug: 'specs', path: '' });
  });

  it('refuses more than three segments, and anything outside the slug alphabet', () => {
    expect(parseRepoTarget('@a/b/c/d:x')).toBe('malformed');
    expect(parseRepoTarget('@:x')).toBe('malformed');
    expect(parseRepoTarget('@a b:x')).toBe('malformed');
    expect(parseRepoTarget('@a"b:x')).toBe('malformed');
    expect(parseRepoTarget('@specs:../../etc/passwd')).toBe('malformed');
  });

  it('lands the two spellings an author has to hand on the same page', () => {
    for (const written of [
      '@specs:guides/rotation',
      '@specs:guides/03-rotation.md',
      '@specs:Guides/Rotation',
      '@specs:guides/rotation/',
    ]) {
      expect(parseRepoTarget(written)).toMatchObject({ path: 'guides/rotation' });
    }
    expect(parseRepoTarget('@specs:guides/rotation/index.md')).toMatchObject({
      path: 'guides/rotation',
    });
  });

  it('emits only slug characters, so nothing typed reaches an href', () => {
    const parsed = parseRepoTarget('@specs:a<b>c/d"e');
    expect(parsed).not.toBe('malformed');
    expect((parsed as { path: string }).path).toMatch(/^[a-z0-9/-]*$/);
  });
});

describe('repoTargetUrl', () => {
  it('omits the forge for the primary one, because a URL that spells it does not resolve', () => {
    expect(repoTargetUrl(parseRepoTarget('@gh/copetence/specs:x') as never, POLICY)).toBe(
      '/specs/x',
    );
    expect(repoTargetUrl(parseRepoTarget('@gitlab/acme/docs:x') as never, POLICY)).toBe(
      '/gitlab/acme/docs/x',
    );
  });

  it('writes an omitted namespace out, then drops it again when it is the default', () => {
    expect(repoTargetUrl(parseRepoTarget('@specs:x') as never, POLICY)).toBe('/specs/x');
    expect(repoTargetUrl(parseRepoTarget('@copetence/specs:x') as never, POLICY)).toBe('/specs/x');
    expect(repoTargetUrl(parseRepoTarget('@northwind-engineering/specs:x') as never, POLICY)).toBe(
      '/northwind-engineering/specs/x',
    );
  });

  it('addresses a repository landing page with a trailing slash', () => {
    expect(repoTargetUrl(parseRepoTarget('@specs') as never, POLICY)).toBe('/specs/');
  });

  it('answers nothing when the instance cannot say', () => {
    const noDefault: RepoAddressPolicy = {
      primaryForgeId: 'gh',
      defaultRepositoryOwnerSlug: () => undefined,
    };
    expect(repoTargetUrl(parseRepoTarget('@specs:x') as never, noDefault)).toBeNull();
    expect(repoTargetUrl(parseRepoTarget('@copetence/specs:x') as never, noDefault)).toBe(
      '/copetence/specs/x',
    );

    const noForge: RepoAddressPolicy = {
      primaryForgeId: null,
      defaultRepositoryOwnerSlug: () => 'x',
    };
    expect(repoTargetUrl(parseRepoTarget('@copetence/specs:x') as never, noForge)).toBeNull();
  });
});

describe('page candidates and the name index', () => {
  it('tries the extensionless spellings, and only for a target that has no extension', () => {
    expect(pageCandidates('guide')).toEqual([
      'guide',
      'guide.md',
      'guide.mdx',
      'guide/index.md',
      'guide/index.mdx',
    ]);
    expect(pageCandidates('diagram.png')).toEqual(['diagram.png']);
  });

  it('answers to the filename as written and to its slug', () => {
    expect(nameKeysFor('docs/Shared Env Secrets.md')).toEqual([
      'shared env secrets',
      'shared-env-secrets',
    ]);
    expect(nameKeysFor('docs/03-setup.mdx')).toEqual(['03-setup', 'setup']);
  });

  it('orders an ambiguous name the same way every time', () => {
    const index = buildNameIndex(
      ['docs/z/vault.md', 'docs/vault.md', 'docs/a/vault.md'],
      (path) => path,
    );
    expect(index.get('vault')).toEqual(['docs/vault.md', 'docs/a/vault.md', 'docs/z/vault.md']);
  });
});
