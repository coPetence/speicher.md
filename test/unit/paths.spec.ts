import {
  deslugify,
  isReservedSegment,
  slugify,
  splitNumericPrefix,
  splitPath,
} from '../../src/common/slug';
import {
  emailPrincipal,
  groupPrincipal,
  intersectPrincipals,
  parsePrincipal,
  subjectPrincipal,
} from '../../src/common/principals';
import {
  REPO_BASE_SENTINEL,
  mimeForPath,
  resolveRelative,
  slugAssetPath,
  slugForContentFile,
  splitTarget,
  withRepoBase,
} from '../../src/ingest/paths';

describe('ordering and slugs', () => {
  it('strips a numeric prefix from the slug but keeps it as the order', () => {
    expect(slugForContentFile('01-introduction.md')).toEqual({ order: 1, slug: 'introduction' });
    expect(slugForContentFile('03-introduction.md')).toEqual({ order: 3, slug: 'introduction' });
    expect(slugForContentFile('troubleshooting.md')).toEqual({
      order: null,
      slug: 'troubleshooting',
    });
  });

  it('leaves a name that is only digits alone', () => {
    expect(splitNumericPrefix('2024')).toEqual({ order: null, rest: '2024' });
  });

  it('does not read a year as a sort key', () => {
    expect(splitNumericPrefix('2024-annual-report')).toEqual({
      order: null,
      rest: '2024-annual-report',
    });
    expect(slugForContentFile('2024-annual-report.md')).toEqual({
      order: null,
      slug: '2024-annual-report',
    });
  });

  it('still parses the unpadded case the numeric prefix exists for', () => {
    expect(splitNumericPrefix('9-nine')).toEqual({ order: 9, rest: 'nine' });
    expect(splitNumericPrefix('10-ten')).toEqual({ order: 10, rest: 'ten' });
    expect(splitNumericPrefix('100-hundred')).toEqual({ order: 100, rest: 'hundred' });
  });

  it('transliterates German umlauts rather than dropping them', () => {
    expect(slugify('Prüfung')).toBe('pruefung');
    expect(slugify('Größe')).toBe('groesse');
  });

  it('collapses everything else to hyphens', () => {
    expect(slugify('Hello, World! (2026)')).toBe('hello-world-2026');
  });

  it('de-slugs for display', () => {
    expect(deslugify('getting-started')).toBe('Getting started');
  });
});

describe('reserved first segments', () => {
  it('reserves the admin prefix and the auth mount', () => {
    expect(isReservedSegment('-')).toBe(true);
    expect(isReservedSegment('api')).toBe(true);
  });

  it('reserves anything normalising to empty', () => {
    expect(isReservedSegment('--')).toBe(true);
    expect(isReservedSegment('.-.')).toBe(true);
    expect(isReservedSegment('...')).toBe(true);
  });

  it('reserves the path-hazardous names regardless of routing', () => {
    expect(isReservedSegment('.')).toBe(true);
    expect(isReservedSegment('..')).toBe(true);
  });

  it('leaves an ordinary repo slug alone', () => {
    expect(isReservedSegment('handbook')).toBe(false);
  });
});

describe('path splitting refuses traversal outright', () => {
  it('splits an ordinary path', () => {
    expect(splitPath('/handbook/commercial/pricing')).toEqual([
      'handbook',
      'commercial',
      'pricing',
    ]);
  });

  it('returns null rather than resolving `..`', () => {
    expect(splitPath('/handbook/../../etc/passwd')).toBeNull();
    expect(splitPath('/handbook/./x')).toBeNull();
  });

  it('rejects a null byte, which truncates a path in several C libraries', () => {
    const nul = String.fromCharCode(0);
    expect(splitPath(`/handbook/x${nul}y`)).toBeNull();
    expect(splitPath('/handbook/x y')).toEqual(['handbook', 'x y']);
  });
});

describe('relative resolution stays inside the repo', () => {
  it('resolves a sibling', () => {
    expect(resolveRelative('docs/commercial', 'pricing.md')).toBe('docs/commercial/pricing.md');
  });

  it('resolves a parent reference', () => {
    expect(resolveRelative('docs/commercial', '../01-introduction.md')).toBe(
      'docs/01-introduction.md',
    );
  });

  it('refuses a target that climbs out of the tree', () => {
    expect(resolveRelative('docs', '../../etc/passwd')).toBeNull();
  });

  it('treats a leading slash as repo-root-relative', () => {
    expect(resolveRelative('docs/commercial', '/cover.png')).toBe('cover.png');
  });
});

describe('asset paths keep their extension', () => {
  it('slugs the stem and lowercases the extension', () => {
    expect(slugAssetPath('images/Rate Card.PNG')).toBe('images/rate-card.png');
  });

  it('maps a known extension to a MIME type', () => {
    expect(mimeForPath('a/b.png')).toBe('image/png');
    expect(mimeForPath('a/b.pdf')).toBe('application/pdf');
  });

  it('falls back to octet-stream rather than guessing from bytes', () => {
    expect(mimeForPath('a/b.unknownext')).toBe('application/octet-stream');
  });
});

describe('the repo-base sentinel', () => {
  it('splits a fragment off a link target', () => {
    expect(splitTarget('page.md#anchor')).toEqual({ path: 'page.md', suffix: '#anchor' });
    expect(splitTarget('page.md')).toEqual({ path: 'page.md', suffix: '' });
  });

  it('is replaced with the repo base at render time', () => {
    const stored = `<a href="${REPO_BASE_SENTINEL}/introduction">x</a>`;
    expect(withRepoBase(stored, '/copetence/handbook')).toBe(
      '<a href="/copetence/handbook/introduction">x</a>',
    );
  });

  it('starts with a slash, so an unrewritten link fails loudly at the site root', () => {
    expect(REPO_BASE_SENTINEL.startsWith('/')).toBe(true);
  });
});

describe('principals', () => {
  it('keeps the case of group names and provider ids', () => {
    expect(groupPrincipal('Commercial')).toBe('group:Commercial');
    expect(subjectPrincipal('Entra', 'ABC')).toBe('user:Entra:ABC');
  });

  it('preserves subject case, since `sub` is an arbitrary string in OIDC', () => {
    expect(subjectPrincipal('entra', 'MixedCase')).toBe('user:entra:MixedCase');
  });

  it('lowercases an email principal', () => {
    expect(emailPrincipal('entra', 'Person@Example.TEST')).toBe(
      'user:entra:email:person@example.test',
    );
    expect(emailPrincipal('Entra', 'Person@Example.TEST')).toBe(
      'user:Entra:email:person@example.test',
    );
  });

  it('round-trips every form', () => {
    expect(parsePrincipal('group:commercial')).toEqual({ kind: 'group', name: 'commercial' });
    expect(parsePrincipal('user:entra:7c9e')).toEqual({
      kind: 'subject',
      provider: 'entra',
      subject: '7c9e',
    });
    expect(parsePrincipal('user:partner-kc:email:a@b.test')).toEqual({
      kind: 'email',
      provider: 'partner-kc',
      email: 'a@b.test',
    });
  });

  it('does not mistake a subject containing a colon for an email form', () => {
    expect(parsePrincipal('user:entra:a:b')).toEqual({
      kind: 'subject',
      provider: 'entra',
      subject: 'a:b',
    });
  });

  it('intersects to the common subset and never to a union', () => {
    expect(intersectPrincipals(['group:a', 'group:b'], ['group:b', 'group:c'])).toEqual([
      'group:b',
    ]);
    expect(intersectPrincipals([], ['group:a'])).toEqual([]);
    expect(intersectPrincipals(['group:a'], [])).toEqual([]);
  });
});
