import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import { SpeicherConfig } from '../../src/config/types';
import { ResolvedConfig, fold, instanceRoot } from '../../src/ingest/cascade';
import { FindingList } from '../../src/ingest/findings';
import { PublicGrant } from '../../src/ingest/grants';

let config: ConfigService;

beforeAll(() => {
  config = new ConfigService(loadInstanceConfigFromFile(process.env.SPEICHER_CONFIG as string));
});

const GRANT_CONTEXT = (publicGrant: PublicGrant = 'disabled') => ({
  config,
  now: new Date('2026-08-21T12:00:00Z'),
  requireUntil: true,
  expiryWarningMs: 14 * 86_400_000,
  publicGrant,
});

async function foldInto(
  parent: ResolvedConfig,
  child: SpeicherConfig,
  isRoot = false,
  publicGrant: PublicGrant = 'disabled',
): Promise<{ resolved: ResolvedConfig; findings: FindingList }> {
  const findings = new FindingList();
  const resolved = await fold(
    parent,
    child,
    {
      isRoot,
      source: isRoot ? '.speicher.yaml' : 'docs/sub/.speicher.yaml',
      baseDir: isRoot ? '' : 'docs/sub',
      grantContext: GRANT_CONTEXT(publicGrant),
    },
    findings,
  );
  return { resolved, findings };
}

async function root(
  access: SpeicherConfig['access'],
  publicGrant: PublicGrant = 'disabled',
): Promise<ResolvedConfig> {
  const { resolved } = await foldInto(
    instanceRoot(config),
    { version: 1, access },
    true,
    publicGrant,
  );
  return resolved;
}

describe('`public` is a principal, and both halves of the grant are required', () => {
  it('resolves to a principal in a repository the instance has published', async () => {
    const resolved = await root(['public', 'engineering'], 'enabled');
    expect(resolved.principals).toEqual(['group:engineering', 'group:public']);
  });

  it('rejects the repository that names it without the instance having said so', async () => {
    const { findings } = await foldInto(
      instanceRoot(config),
      { version: 1, access: ['public'] },
      true,
      'disabled',
    );
    expect(findings.rejections.map((f) => f.code)).toEqual(['public-not-enabled']);
    expect(findings.all.map((f) => f.code)).not.toContain('unknown-group');
  });

  it('refuses it in `maintainers` however the instance is configured', async () => {
    const findings = new FindingList();
    await fold(
      instanceRoot(config),
      { version: 1, access: ['public'] },
      {
        isRoot: true,
        source: '.speicher.yaml',
        baseDir: '',
        grantContext: GRANT_CONTEXT('refused'),
      },
      findings,
    );
    expect(findings.rejections.map((f) => f.code)).toEqual(['public-not-a-maintainer']);
  });

  it('names the missing root grant when a public root has a narrowed subtree', async () => {
    const parent = await root(['public'], 'enabled');
    const { resolved, findings } = await foldInto(parent, { access: ['engineering'] });
    expect(resolved.principals).toEqual([]);
    expect(findings.all.map((f) => f.code)).toContain('public-narrowed-away');
    expect(findings.all.map((f) => f.code)).not.toContain('empty-read-set');
    expect(findings.all.find((f) => f.code === 'public-narrowed-away')?.message).toContain(
      'engineering',
    );
    expect(findings.hasRejection).toBe(false);
  });

  it('says nothing of the kind when a public root narrows to a group it granted', async () => {
    const parent = await root(['public', 'engineering'], 'enabled');
    const { resolved, findings } = await foldInto(parent, { access: ['engineering'] });
    expect(resolved.principals).toEqual(['group:engineering']);
    expect(findings.all.map((f) => f.code)).not.toContain('public-narrowed-away');
  });
});

describe('intersect — access', () => {
  it('reads as the grant at the repo root, where there is no parent', async () => {
    const resolved = await root(['engineering', 'commercial']);
    expect(resolved.principals).toEqual(['group:commercial', 'group:engineering']);
  });

  it('narrows at a folder', async () => {
    const parent = await root(['engineering', 'commercial']);
    const { resolved } = await foldInto(parent, { access: ['commercial'] });
    expect(resolved.principals).toEqual(['group:commercial']);
  });

  it('does not widen when a folder names a group the parent did not grant', async () => {
    const parent = await root(['commercial']);
    const { resolved } = await foldInto(parent, { access: ['engineering', 'commercial'] });
    expect(resolved.principals).toEqual(['group:commercial']);
  });

  it('can intersect to nobody, which is valid but flagged', async () => {
    const parent = await root(['commercial']);
    const { resolved, findings } = await foldInto(parent, { access: ['engineering'] });
    expect(resolved.principals).toEqual([]);
    expect(findings.all.map((f) => f.code)).toContain('empty-read-set');
    expect(findings.hasRejection).toBe(false);
  });

  it('flags a folder access that removes nothing', async () => {
    const parent = await root(['commercial']);
    const { findings } = await foldInto(parent, { access: ['commercial'] });
    expect(findings.all.map((f) => f.code)).toContain('noop-narrowing');
  });

  it('leaves the parent set untouched when a folder declares no access', async () => {
    const parent = await root(['engineering', 'commercial']);
    const { resolved } = await foldInto(parent, { display: { title: 'Sub' } });
    expect(resolved.principals).toEqual(parent.principals);
  });

  it('rejects a repo-root config with no access block at all', async () => {
    const findings = new FindingList();
    await fold(
      instanceRoot(config),
      { version: 1 },
      { isRoot: true, source: '.speicher.yaml', baseDir: '', grantContext: GRANT_CONTEXT() },
      findings,
    );
    expect(findings.rejections.map((f) => f.code)).toContain('access-missing');
  });

  it('accepts the bare-list shorthand for groups', async () => {
    const asList = await root(['engineering']);
    const asObject = await root({ groups: ['engineering'] });
    expect(asList.principals).toEqual(asObject.principals);
  });

  it('intersects individual grants like any other principal', async () => {
    const parent = await root({
      groups: ['engineering'],
      users: [{ subject: 'dave-oid', note: 'reviewer', until: '2099-12-31' }],
    });
    expect(parent.principals).toEqual(['group:engineering', 'user:entra:dave-oid']);

    const { resolved } = await foldInto(parent, {
      access: { users: [{ subject: 'dave-oid', note: 'reviewer', until: '2099-12-31' }] },
    });
    expect(resolved.principals).toEqual(['user:entra:dave-oid']);
  });
});

describe('and — retrieval.indexable', () => {
  it('honours true -> false', async () => {
    const parent = await root(['engineering']);
    const { resolved } = await foldInto(parent, { retrieval: { indexable: false } });
    expect(resolved.indexable).toBe(false);
  });

  it('ignores false -> true', async () => {
    const parent = await root(['engineering']);
    const { resolved: off } = await foldInto(parent, { retrieval: { indexable: false } });
    const { resolved: backOn } = await foldInto(off, { retrieval: { indexable: true } });
    expect(backOn.indexable).toBe(false);
  });

  it('inherits when unspecified', async () => {
    const parent = await root(['engineering']);
    const { resolved } = await foldInto(parent, {});
    expect(resolved.indexable).toBe(true);
  });
});

describe('append — sync.exclude', () => {
  it('accumulates rather than replacing', async () => {
    const parent = await root(['engineering']);
    const { resolved } = await foldInto(parent, { sync: { exclude: ['drafts/**'] } });
    expect(resolved.exclude).toEqual(['**/README.md', 'drafts/**']);
  });

  it('cannot remove an inherited exclusion', async () => {
    const parent = await root(['engineering']);
    const { resolved: level1 } = await foldInto(parent, { sync: { exclude: ['drafts/**'] } });
    const { resolved: level2 } = await foldInto(level1, { sync: { exclude: ['notes/**'] } });
    expect(level2.exclude).toEqual(['**/README.md', 'drafts/**', 'notes/**']);
  });
});

describe('replace — sync.include', () => {
  it('replaces wholesale', async () => {
    const parent = await root(['engineering']);
    const { resolved } = await foldInto(parent, { sync: { include: ['**/*.markdown'] } });
    expect(resolved.include).toEqual(['**/*.markdown']);
  });

  it('inherits when unspecified', async () => {
    const parent = await root(['engineering']);
    const { resolved } = await foldInto(parent, {});
    expect(resolved.include).toEqual(['**/*.md']);
  });
});

describe('override — display', () => {
  it('lets the nearest ancestor win, and carries the declaring directory with it', async () => {
    const findings = new FindingList();
    const rootResolved = await fold(
      instanceRoot(config),
      { version: 1, access: ['engineering'], display: { cover: 'cover.png' } },
      { isRoot: true, source: '.speicher.yaml', baseDir: '', grantContext: GRANT_CONTEXT() },
      findings,
    );
    expect(rootResolved.cover).toEqual({ path: 'cover.png', baseDir: '' });

    const { resolved: inherited } = await foldInto(rootResolved, {});
    expect(inherited.cover).toEqual({ path: 'cover.png', baseDir: '' });

    const { resolved: overridden } = await foldInto(rootResolved, {
      display: { cover: 'images/other.png' },
    });
    expect(overridden.cover).toEqual({ path: 'images/other.png', baseDir: 'docs/sub' });
  });

  it('treats cover: null as "show none" rather than as an absence', async () => {
    const findings = new FindingList();
    const rootResolved = await fold(
      instanceRoot(config),
      { version: 1, access: ['engineering'], display: { cover: 'cover.png' } },
      { isRoot: true, source: '.speicher.yaml', baseDir: '', grantContext: GRANT_CONTEXT() },
      findings,
    );
    const { resolved } = await foldInto(rootResolved, { display: { cover: null } });
    expect(resolved.cover).toBeNull();
  });

  it('does not inherit display.title, which names the level that declares it', async () => {
    const parent = await root(['engineering']);
    const { resolved: titled } = await foldInto(parent, { display: { title: 'Commercial' } });
    expect(titled.ownTitle).toBe('Commercial');

    const { resolved: child } = await foldInto(titled, {});
    expect(child.ownTitle).toBeUndefined();
  });
});

describe('grants', () => {
  it('rejects a subject without a note', async () => {
    const findings = new FindingList();
    await fold(
      instanceRoot(config),
      { version: 1, access: { users: [{ subject: 'x-oid', until: '2099-12-31' }] } },
      { isRoot: true, source: '.speicher.yaml', baseDir: '', grantContext: GRANT_CONTEXT() },
      findings,
    );
    expect(findings.rejections.map((f) => f.code)).toContain('grant-missing-note');
  });

  it('rejects an individual grant without until', async () => {
    const findings = new FindingList();
    await fold(
      instanceRoot(config),
      { version: 1, access: { users: [{ subject: 'x-oid', note: 'someone' }] } },
      { isRoot: true, source: '.speicher.yaml', baseDir: '', grantContext: GRANT_CONTEXT() },
      findings,
    );
    expect(findings.rejections.map((f) => f.code)).toContain('grant-missing-until');
  });

  it('drops an expired grant silently and reports it as info', async () => {
    const findings = new FindingList();
    const resolved = await fold(
      instanceRoot(config),
      {
        version: 1,
        access: {
          groups: ['engineering'],
          users: [{ subject: 'gone-oid', note: 'left in 2025', until: '2025-01-01' }],
        },
      },
      { isRoot: true, source: '.speicher.yaml', baseDir: '', grantContext: GRANT_CONTEXT() },
      findings,
    );
    expect(resolved.principals).toEqual(['group:engineering']);
    const expired = findings.all.filter((f) => f.code === 'grant-expired');
    expect(expired).toHaveLength(1);
    expect(expired[0].severity).toBe('info');
    expect(resolved.droppedGrants).toEqual([
      { principal: 'user:entra:gone-oid', reason: 'expired 2025-01-01' },
    ]);
  });

  it('warns about a grant expiring inside the warning window', async () => {
    const findings = new FindingList();
    await fold(
      instanceRoot(config),
      {
        version: 1,
        access: { users: [{ subject: 'soon-oid', note: 'ending', until: '2026-08-25' }] },
      },
      { isRoot: true, source: '.speicher.yaml', baseDir: '', grantContext: GRANT_CONTEXT() },
      findings,
    );
    expect(findings.all.map((f) => f.code)).toContain('grant-expiring');
  });

  it('reports the minimum until as the next expiry, for next_grant_review_at', async () => {
    const findings = new FindingList();
    const resolved = await fold(
      instanceRoot(config),
      {
        version: 1,
        access: {
          users: [
            { subject: 'a-oid', note: 'a', until: '2030-01-01' },
            { subject: 'b-oid', note: 'b', until: '2027-06-30' },
          ],
        },
      },
      { isRoot: true, source: '.speicher.yaml', baseDir: '', grantContext: GRANT_CONTEXT() },
      findings,
    );
    expect(resolved.nextExpiry?.toISOString()).toBe('2027-06-30T23:59:59.999Z');
  });

  it('rejects an unknown group and suggests the nearest name', async () => {
    const findings = new FindingList();
    await fold(
      instanceRoot(config),
      { version: 1, access: ['commerical'] },
      { isRoot: true, source: '.speicher.yaml', baseDir: '', grantContext: GRANT_CONTEXT() },
      findings,
    );
    const rejection = findings.rejections.find((f) => f.code === 'unknown-group');
    expect(rejection).toBeDefined();
    expect(rejection!.suggestion).toBe('commercial');
  });

  it('matches a group name exactly, so another case is an unknown group', async () => {
    const findings = new FindingList();
    const resolved = await fold(
      instanceRoot(config),
      { version: 1, access: ['Commercial'] },
      { isRoot: true, source: '.speicher.yaml', baseDir: '', grantContext: GRANT_CONTEXT() },
      findings,
    );
    expect(findings.rejections.find((f) => f.code === 'unknown-group')?.suggestion).toBe(
      'commercial',
    );
    expect(resolved.principals).not.toContain('group:commercial');
  });

  it('does not read another case of `public` as the public group', async () => {
    const findings = new FindingList();
    const resolved = await fold(
      instanceRoot(config),
      { version: 1, access: ['Public'] },
      { isRoot: true, source: '.speicher.yaml', baseDir: '', grantContext: GRANT_CONTEXT() },
      findings,
    );
    expect(resolved.principals).not.toContain('group:public');
    expect(findings.rejections.map((f) => f.code)).toContain('unknown-group');
  });
});
