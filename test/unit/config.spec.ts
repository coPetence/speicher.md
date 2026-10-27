import { discoveryHint, hasGroupsOverage } from '../../src/auth/oidc.service';
import { problem, wordingFor } from '../../src/common/config-problems';
import { ConfigError } from '../../src/common/errors';
import { refusalOf } from '../helpers/refuse-with';
import { parseStrictYaml } from '../../src/common/yaml';
import { ConfigService, defaultBrand } from '../../src/config/config.service';
import { interpolateEnv } from '../../src/config/env-interpolation';
import { adminLockout } from '../../src/config/checks/admins';
import { loadInstanceConfig } from '../../src/config/parser';
import { referrersOf } from '../../src/config/groups';
import { computeResolutionHash } from '../../src/config/resolution-hash';
import { NEUTRAL_BRAND, gitRepositoryOwner } from '../../src/config/types';

const MINIMAL = `
version: 1
auth:
  providers:
    entra:
      type: oidc
      issuer: https://login.example.test/v2.0
      client_id: abc
groups:
  engineering:
    - { provider: entra, id: "grp-eng" }
admins:
  groups: [engineering]
forges:
  gh:
    type: github
    app_id: "1"
    private_key: k
    webhook_secret: s
`;

function load(yaml: string) {
  return loadInstanceConfig(yaml);
}

describe('the webhook secret of a source', () => {
  it('is optional for a GitHub App, which may have been created without a webhook', () => {
    expect(() => load(MINIMAL.replace('    webhook_secret: s\n', ''))).not.toThrow();
  });

  it('is still required for a token-based forge', () => {
    const gitlab = MINIMAL.replace(
      'type: github\n    app_id: "1"\n    private_key: k\n    webhook_secret: s',
      'type: gitlab\n    token: t',
    );
    expect(() => load(gitlab)).toRefuseWith('schema.required', {
      path: 'forges.gh.webhook_secret',
    });
  });
});

describe('YAML 1.2 core schema, strictly', () => {
  it('rejects anchors', () => {
    expect(() => parseStrictYaml('a: &x 1\nb: 2\n')).toFailWith('yaml.anchor');
  });

  it('rejects aliases', () => {
    expect(() => parseStrictYaml('a: &x 1\nb: *x\n')).toFailWith('yaml.anchor');
  });

  it('rejects merge keys', () => {
    expect(() => parseStrictYaml('base: {a: 1}\nchild:\n  <<: {b: 2}\n')).toFailWith(
      'yaml.merge-key',
    );
  });

  it('rejects duplicate keys rather than letting the last one win', () => {
    expect(() => parseStrictYaml('access: [a]\naccess: [b]\n')).toThrow();
  });

  it('does not coerce YAML 1.1 booleans', () => {
    const { value } = parseStrictYaml<{ a: unknown; b: unknown }>('a: no\nb: on\n');
    expect(value.a).toBe('no');
    expect(value.b).toBe('on');
  });

  it('does not mistake a glob for an alias', () => {
    const { value } = parseStrictYaml<{ sync: { exclude: string[] } }>(
      'sync:\n  exclude: ["**/*.md", drafts/**]\n',
    );
    expect(value.sync.exclude).toEqual(['**/*.md', 'drafts/**']);
  });

  it('reports the line of a key, for check annotations', () => {
    const { lineOf } = parseStrictYaml('version: 1\naccess:\n  groups: [a]\n');
    expect(lineOf('access.groups')).toBe(3);
  });
});

describe('${VAR} interpolation', () => {
  it('substitutes into scalars', () => {
    expect(interpolateEnv({ a: 'x${FOO}y' }, { FOO: 'bar' } as NodeJS.ProcessEnv)).toEqual({
      a: 'xbary',
    });
  });

  it('cannot change the structure of the document it lands in', () => {
    const out = interpolateEnv({ password: '${SECRET}' }, {
      SECRET: 'value: injected',
    } as NodeJS.ProcessEnv);
    expect(out).toEqual({ password: 'value: injected' });
  });

  it('keeps a numeric secret a string', () => {
    const out = interpolateEnv({ app_id: '${ID}' }, { ID: '424242' } as NodeJS.ProcessEnv);
    expect(out.app_id).toBe('424242');
    expect(typeof out.app_id).toBe('string');
  });

  it('names every missing variable at once', () => {
    const err = refusalOf(() =>
      interpolateEnv({ a: '${ONE}', b: '${TWO}' }, {} as NodeJS.ProcessEnv),
    );
    expect(err.code).toBe('config.env-missing');
    expect(
      err.issues.map((p) => [p.code, p.text.includes('ONE') || p.text.includes('TWO')]),
    ).toEqual([
      ['env.unset', true],
      ['env.unset', true],
    ]);
  });

  it('treats an empty variable as unset, which is what compose passes', () => {
    expect(() =>
      interpolateEnv({ a: '${TOKEN}' }, { TOKEN: '' } as NodeJS.ProcessEnv),
    ).toRefuseWith('env.unset');
  });
});

describe('cross-field validation', () => {
  it('accepts a minimal single-forge config', () => {
    const loaded = load(MINIMAL);
    expect(loaded.primaryForgeId).toBe('gh');
  });

  it('makes the sole forge primary by default', () => {
    expect(load(MINIMAL).raw.forges?.gh.primary).toBeUndefined();
    expect(load(MINIMAL).primaryForgeId).toBe('gh');
  });

  it('refuses two forges with none designated primary', () => {
    const yaml = MINIMAL.concat('  gl:\n    type: gitlab\n    token: t\n    webhook_secret: s\n');
    expect(() => load(yaml)).toRefuseWith('forges.primary-missing');
  });

  it('refuses two forges both marked primary', () => {
    const yaml = MINIMAL.replace(
      '  gh:\n    type: github',
      '  gh:\n    primary: true\n    type: github',
    ).concat('  gl:\n    primary: true\n    type: gitlab\n    token: t\n    webhook_secret: s\n');
    expect(() => load(yaml)).toRefuseWith('forges.primary-ambiguous');
  });

  it('rejects a magic-link provider with no mail block', () => {
    const yaml = MINIMAL.replace(
      '      client_id: abc',
      '      client_id: abc\n    magic:\n      type: magic-link',
    );
    expect(() => load(yaml)).toRefuseWith('providers.magic-link-needs-mail');
  });

  it('rejects a group source naming an unconfigured provider', () => {
    const yaml = MINIMAL.replace('provider: entra, id: "grp-eng"', 'provider: nope, id: "grp-eng"');
    expect(() => load(yaml)).toRefuseWith('groups.unknown-provider', {
      path: 'groups.engineering[0].provider',
    });
  });

  it('rejects a domain group on a non-magic-link provider', () => {
    const yaml = MINIMAL.replace(
      '{ provider: entra, id: "grp-eng" }',
      '{ provider: entra, domain: "acme.test" }',
    );
    expect(() => load(yaml)).toRefuseWith('groups.domain-needs-magic-link');
  });

  it('rejects an admins group that is not in the groups map', () => {
    const yaml = MINIMAL.replace('groups: [engineering]\nforges', 'groups: [nope]\nforges');
    expect(() => load(yaml)).toRefuseWith('admins.unknown-group', { path: 'admins.groups' });
  });

  it('rejects a forge id that lands on a reserved first segment', () => {
    const yaml = MINIMAL.replace(
      '    type: github\n',
      '    type: github\n    primary: true\n',
    ).concat('  api:\n    type: gitlab\n    token: t\n    webhook_secret: s\n');
    expect(() => load(yaml)).toRefuseWith('forges.segment-reserved', { path: 'forges.api' });
  });

  it('names every missing environment variable in one error', () => {
    expect(() => load(MINIMAL.replace('client_id: abc', 'client_id: ${NOPE}'))).toThrow(
      ConfigError,
    );
  });
});

describe('provider, group and forge keys', () => {
  it('may carry capitals', () => {
    const yaml = MINIMAL.replace(
      '  engineering:\n    - { provider: entra, id: "grp-eng" }',
      '  engineering:\n    - { provider: entra, id: "grp-eng" }\n  Platform-Team:\n    - { provider: entra, id: "grp-pt" }',
    );
    expect(Object.keys(load(yaml).raw.groups ?? {})).toContain('Platform-Team');
  });

  it('refuses two that differ only in case', () => {
    const yaml = MINIMAL.replace(
      '  engineering:\n    - { provider: entra, id: "grp-eng" }',
      '  engineering:\n    - { provider: entra, id: "grp-eng" }\n  Engineering:\n    - { provider: entra, id: "grp-eng-2" }',
    );
    expect(() => load(yaml)).toRefuseWith('names.case-collision', { path: 'groups.Engineering' });
  });
});

describe('`public` is reserved', () => {
  it('refuses an instance that defines a group by that name', () => {
    const yaml = MINIMAL.replace(
      '  engineering:\n    - { provider: entra, id: "grp-eng" }',
      '  engineering:\n    - { provider: entra, id: "grp-eng" }\n  public:\n    - { provider: entra, id: "grp-pr" }',
    );
    expect(() => load(yaml)).toRefuseWith('names.reserved', { path: 'groups.public' });
  });

  it('refuses it in admins.groups', () => {
    const yaml = MINIMAL.replace('  groups: [engineering]', '  groups: [engineering, public]');
    expect(() => load(yaml)).toRefuseWith('names.reserved', { path: 'admins.groups' });
  });

  it('reserves `setup` among provider ids, for the same reason', () => {
    const yaml = MINIMAL.replace('    entra:', '    setup:');
    expect(() => load(yaml)).toRefuseWith('names.reserved', { path: 'auth.providers.setup' });
  });

  it('reserves both names in any case', () => {
    const group = MINIMAL.replace(
      '  engineering:\n    - { provider: entra, id: "grp-eng" }',
      '  engineering:\n    - { provider: entra, id: "grp-eng" }\n  Public:\n    - { provider: entra, id: "grp-pr" }',
    );
    expect(() => load(group)).toRefuseWith('names.reserved', { path: 'groups.Public' });

    const admin = MINIMAL.replace('  groups: [engineering]', '  groups: [engineering, Public]');
    expect(() => load(admin)).toRefuseWith('names.reserved', { path: 'admins.groups' });

    const provider = MINIMAL.replace('    entra:', '    Setup:');
    expect(() => load(provider)).toRefuseWith('names.reserved', { path: 'auth.providers.Setup' });
  });

  it('accepts an instance that publishes a repository', () => {
    const yaml = MINIMAL.replace(
      'admins:\n  groups: [engineering]',
      'admins:\n  groups: [engineering]\npublic:\n  repos: [acme/docs]',
    );
    expect(load(yaml).raw.public?.repos).toEqual(['acme/docs']);
  });

  it('refuses a repository named as something other than namespace/slug', () => {
    const yaml = MINIMAL.replace(
      'admins:\n  groups: [engineering]',
      'admins:\n  groups: [engineering]\npublic:\n  repos: [docs]',
    );
    expect(() => load(yaml)).toRefuseWith('config.schema');
  });
});

describe('a group with no sources', () => {
  const EMPTY = MINIMAL.replace('\nadmins:\n', '\n  contractors: []\nadmins:\n');

  it('loads, and the name exists with nobody in it', () => {
    expect(load(EMPTY).raw.groups!.contractors).toEqual([]);
  });

  it('matches nobody, whatever the token carries', () => {
    const groups = new ConfigService(load(EMPTY)).resolveInternalGroups(
      'entra',
      ['grp-eng', 'contractors', 'grp-contractors'],
      { subject: 'oid-42', email: 'someone@copetence.test' },
      new Date('2026-06-01T12:00:00Z'),
    );
    expect(groups).toEqual(['engineering']);
  });

  it('boots when it is the only thing granting administrator access, and cannot be saved', () => {
    const yaml = MINIMAL.replace(
      '  engineering:\n    - { provider: entra, id: "grp-eng" }',
      '  engineering: []',
    );
    expect(() => load(yaml)).not.toThrow();

    const lockout = adminLockout(load(yaml).raw);
    expect(lockout?.code).toBe('admins.group-empty');
    expect(lockout?.text).toContain('engineering');
  });

  it('is not a lockout when somebody else still holds the surface', () => {
    const yaml = MINIMAL.replace(
      '  engineering:\n    - { provider: entra, id: "grp-eng" }',
      '  engineering: []',
    ).replace(
      '  groups: [engineering]',
      '  groups: [engineering]\n  users:\n    - { subject: oid-1, note: the operator }',
    );
    expect(() => load(yaml)).not.toThrow();
    expect(adminLockout(load(yaml).raw)).toBeNull();
  });
});

describe('a problem, worded for whoever fixes it', () => {
  const bare = problem('admins.unknown-provider', 'admins.users[0]', {
    text: 'provider "nope" is not configured',
  });
  const both = { ...bare, dashboard: 'The administrator signs in with "nope", which is gone.' };

  it('leads the YAML wording with the key, so the text need not repeat it', () => {
    expect(wordingFor(bare, 'yaml')).toBe('admins.users[0]: provider "nope" is not configured');
    expect(wordingFor(both, 'yaml')).toBe(wordingFor(bare, 'yaml'));
  });

  it('gives the dashboard its own wording, or the YAML one when it has none', () => {
    expect(wordingFor(both, 'dashboard')).toBe(both.dashboard);
    expect(wordingFor(bare, 'dashboard')).toBe(wordingFor(bare, 'yaml'));
  });

  it('keeps a refusal of one problem to that problem, with no headline above it', () => {
    const err = new ConfigError(both);
    expect(err.code).toBe('admins.unknown-provider');
    expect(err.message).toBe(wordingFor(bare, 'yaml'));
    expect(err.issues).toEqual([]);
  });
});

describe('an instance nobody has configured yet', () => {
  const NOTHING = 'version: 1\n';

  it('loads', () => {
    expect(() => load(NOTHING)).not.toThrow();
    expect(load(NOTHING).raw.version).toBe(1);
  });

  it('has no primary forge, no provider and no administrator', () => {
    const config = new ConfigService(load(NOTHING));
    expect(load(NOTHING).primaryForgeId).toBeNull();
    expect(config.providerShortIds).toEqual([]);
    expect(config.defaultProviderId).toBeUndefined();
    expect(config.adminPrincipals()).toEqual([]);
  });

  it('is a lockout, so it cannot be saved from a form', () => {
    expect(adminLockout(load(NOTHING).raw)?.code).toBe('admins.none');
  });

  it('cannot carry groups, because every source names a provider', () => {
    const yaml = `${NOTHING}groups:\n  engineering:\n    - { provider: entra, id: "grp-eng" }\n`;
    expect(() => load(yaml)).toRefuseWith('groups.unknown-provider');
  });

  it('tells an absent block from an empty one', () => {
    expect(() => load(`${NOTHING}admins: {}\n`)).toRefuseWith('config.schema');
    expect(() => load(`${NOTHING}auth:\n  providers: {}\n`)).toRefuseWith('config.schema');
    expect(() => load(`${NOTHING}auth: {}\n`)).toRefuseWith('config.schema');
  });

  it('hashes stably, so the first real save is the only thing that moves it', () => {
    expect(computeResolutionHash(load(NOTHING).raw, null)).toBe(
      computeResolutionHash(load(NOTHING).raw, null),
    );
    expect(computeResolutionHash(load(MINIMAL).raw, 'gh')).not.toBe(
      computeResolutionHash(load(NOTHING).raw, null),
    );
  });
});

describe('an instance with no content source', () => {
  const NONE = MINIMAL.slice(0, MINIMAL.indexOf('forges:'));

  it('loads, with nothing to be the primary forge', () => {
    const loaded = load(NONE);
    expect(loaded.raw.forges).toBeUndefined();
    expect(loaded.primaryForgeId).toBeNull();
  });

  it('loads with the empty map a removal leaves behind', () => {
    expect(load(`${NONE}forges: {}\n`).primaryForgeId).toBeNull();
  });

  it('treats both spellings of "none" as one configuration', () => {
    expect(load(`${NONE}forges: {}\n`).resolutionHash).toBe(load(NONE).resolutionHash);
  });

  it('rebuilds when the first source arrives', () => {
    expect(load(NONE).resolutionHash).not.toBe(load(MINIMAL).resolutionHash);
  });
});

describe('a plain git forge', () => {
  const GIT = `
version: 1
auth:
  providers:
    entra:
      type: oidc
      issuer: https://login.example.test/v2.0
      client_id: abc
groups:
  engineering:
    - { provider: entra, id: "grp-eng" }
admins:
  groups: [engineering]
forges:
  internal:
    type: git
    default_repository_owner: ops
    poll_interval: 24h
    known_hosts: "git.example.test ssh-ed25519 AAAA"
    repos:
      - id: handbook
        url: ssh://git@git.example.test/ops/handbook.git
        deploy_key: "-----BEGIN OPENSSH PRIVATE KEY-----"
`;

  it('loads, and is primary as the sole forge', () => {
    expect(load(GIT).primaryForgeId).toBe('internal');
  });

  it('rejects an ssh remote with no pinned host key', () => {
    const yaml = GIT.replace('    known_hosts: "git.example.test ssh-ed25519 AAAA"\n', '');
    expect(() => load(yaml)).toRefuseWith('forges.ssh-needs-known-hosts');
  });

  it('rejects an ssh remote with no deploy key', () => {
    const yaml = GIT.replace('        deploy_key: "-----BEGIN OPENSSH PRIVATE KEY-----"\n', '');
    expect(() => load(yaml)).toRefuseWith('forges.ssh-needs-deploy-key');
  });

  it('rejects an https remote with no token', () => {
    const yaml = GIT.replace('ssh://git@git.example.test', 'https://git.example.test').replace(
      '        deploy_key: "-----BEGIN OPENSSH PRIVATE KEY-----"\n',
      '',
    );
    expect(() => load(yaml)).toRefuseWith('forges.https-needs-token');
  });

  it('rejects a transport that authenticates no server', () => {
    const yaml = GIT.replace('ssh://git@git.example.test', 'git://git.example.test');
    expect(() => load(yaml)).toThrow(ConfigError);
  });

  it('rejects a remote URL that names no owner', () => {
    const yaml = GIT.replace('git.example.test/ops/handbook.git', 'git.example.test/handbook.git');
    expect(() => load(yaml)).toRefuseWith('forges.repo-url-no-owner');
  });

  it('rejects two repos sharing an id, which would share a mirror', () => {
    const yaml = `${GIT}      - id: handbook
        url: ssh://git@git.example.test/ops/other.git
        deploy_key: k
`;
    expect(() => load(yaml)).toRefuseWith('forges.repo-id-taken');
  });

  it('takes an id in whatever shape the forge calls the repository', () => {
    const yaml = GIT.replace('      - id: handbook', '      - id: Design.System_v2');
    expect(() => load(yaml)).not.toThrow();
  });

  it('refuses an id that could not be a directory under the mirror root', () => {
    for (const id of ['..', '.github', '-x', 'a/b', 'a b']) {
      const yaml = GIT.replace('      - id: handbook', `      - id: ${JSON.stringify(id)}`);
      expect(() => load(yaml)).toRefuseWith('schema.pattern');
    }
  });

  it('refuses two ids that differ only in case, which are one directory', () => {
    const yaml = `${GIT}      - id: Handbook
        url: ssh://git@git.example.test/ops/other.git
        deploy_key: k
`;
    expect(() => load(yaml)).toRefuseWith('forges.repo-id-taken');
  });

  it('rejects two repos whose slugs collide', () => {
    const yaml = `${GIT}      - id: other
        slug: handbook
        url: ssh://git@git.example.test/ops/other.git
        deploy_key: k
`;
    expect(() => load(yaml)).toRefuseWith('forges.repo-slug-taken');
  });

  it('rejects a repo slug that collides with a second forge id', () => {
    const yaml = GIT.replace('    type: git\n', '    type: git\n    primary: true\n').replace(
      '- id: handbook',
      '- id: gl',
    ).concat(`  gl:
    type: gitlab
    token: t
    webhook_secret: s
`);
    expect(() => load(yaml)).toRefuseWith('forges.segment-taken');
  });

  it('rejects a repository owner that collides with a second forge id', () => {
    const yaml = GIT.replace('    type: git\n', '    type: git\n    primary: true\n')
      .replace('    default_repository_owner: ops\n', '')
      .replace('git.example.test/ops/handbook.git', 'git.example.test/gl/handbook.git')
      .concat('  gl:\n    type: gitlab\n    token: t\n    webhook_secret: s\n');
    expect(() => load(yaml)).toRefuseWith('forges.segment-taken');
  });

  it('rejects an owner that collides with a repo of the default owner on a non-primary forge', () => {
    const yaml = `${GIT}      - id: other
        url: ssh://git@git.example.test/handbook/other.git
        deploy_key: k
  gl:
    type: gitlab
    primary: true
    token: t
    webhook_secret: s
`;
    expect(() => load(yaml)).toRefuseWith('forges.segment-taken');
  });

  it('takes the owner from the path of the remote URL', () => {
    const owner = (url: string) => gitRepositoryOwner({ id: 'x', url });
    expect(owner('ssh://git@git.example.test/ops/handbook.git')).toBe('ops');
    expect(owner('https://git.example.test/acme/team/handbook.git')).toBe('acme/team');
    expect(owner('https://git.example.test/handbook.git')).toBeNull();
  });

  it('rejects a poll interval below the floor', () => {
    expect(() => load(GIT.replace('poll_interval: 24h', 'poll_interval: 10s'))).toRefuseWith(
      'forges.poll-interval-too-short',
    );
  });

  it('rejects a webhook secret, which would do nothing here', () => {
    const yaml = GIT.replace('    poll_interval: 24h', '    webhook_secret: s');
    expect(() => load(yaml)).toRefuseWith('forges.webhook-secret-on-git');
  });

  it('keeps the repo list out of the resolution hash', () => {
    const moved = GIT.replace(
      'git.example.test/ops/handbook.git',
      'git.internal.test/ops/handbook.git',
    );
    const slower = GIT.replace('poll_interval: 24h', 'poll_interval: 1h');
    expect(load(moved).resolutionHash).toBe(load(GIT).resolutionHash);
    expect(load(slower).resolutionHash).toBe(load(GIT).resolutionHash);
  });

  it('changes the hash when the forge type does', () => {
    const asGithub = GIT.slice(0, GIT.indexOf('forges:')).concat(
      `forges:
  internal:
    type: github
    default_repository_owner: ops
    app_id: "1"
    private_key: k
    webhook_secret: s
`,
    );
    expect(load(asGithub).resolutionHash).not.toBe(load(GIT).resolutionHash);
  });
});

describe('an individual in a group', () => {
  const withSource = (source: string) =>
    MINIMAL.replace('    - { provider: entra, id: "grp-eng" }', `    - ${source}`);

  it('accepts a person named by the provider’s own subject', () => {
    const loaded = load(
      withSource('{ provider: entra, subject: oid-42, note: "founding engineer" }'),
    );
    expect(new ConfigService(loaded).groupSources('engineering')[0].subject).toBe('oid-42');
  });

  it('accepts a person named by address', () => {
    expect(() =>
      load(withSource('{ provider: entra, email: alice@example.test, note: "contractor" }')),
    ).not.toThrow();
  });

  it('takes a person with no note, which is optional on every shape', () => {
    expect(() => load(withSource('{ provider: entra, subject: oid-42 }'))).not.toThrow();
  });

  it('refuses a source that names two things at once', () => {
    expect(() =>
      load(withSource('{ provider: entra, id: "grp-eng", subject: oid-42 }')),
    ).toRefuseWith('config.schema');
  });

  it('refuses an `until` that is not a date', () => {
    expect(() =>
      load(withSource('{ provider: entra, subject: oid-42, note: n, until: soon }')),
    ).toRefuseWith('config.schema');
  });
});

describe('a Microsoft Graph directory', () => {
  const withDirectory = (extra: string, claim = '      subject_claim: oid\n') =>
    MINIMAL.replace(
      '      client_id: abc\n',
      `      client_id: abc\n${claim}      directory:\n        type: graph\n${extra}`,
    );

  const CREDENTIALS =
    '        tenant_id: a-tenant\n        client_id: graph-client\n        client_secret: s\n';

  it('loads with its own credentials and the object-id claim', () => {
    expect(() => load(withDirectory(CREDENTIALS))).not.toThrow();
  });

  it('refuses one that cannot mint a token, naming the key it is missing', () => {
    expect(() => load(withDirectory('        tenant_id: a-tenant\n'))).toRefuseWith(
      'providers.directory-key-missing',
    );
    expect(() =>
      load(withDirectory('        client_id: c\n        client_secret: s\n')),
    ).toRefuseWith('providers.directory-key-missing');
  });

  it('refuses a per-application subject claim, which nothing it returns could match', () => {
    expect(() => load(withDirectory(CREDENTIALS, ''))).toRefuseWith(
      'providers.directory-needs-oid',
    );
    expect(() => load(withDirectory(CREDENTIALS, '      subject_claim: sub\n'))).toRefuseWith(
      'providers.directory-needs-oid',
    );
  });

  it('says nothing about a claim on a provider with no directory', () => {
    expect(() => load(MINIMAL)).not.toThrow();
  });
});

describe('an address-shaped source under a multi-tenant issuer', () => {
  const withIssuer = (issuer: string, source: string) =>
    MINIMAL.replace(
      'issuer: https://login.example.test/v2.0',
      `issuer: ${issuer}\n      client_secret: s`,
    ).replace('    - { provider: entra, id: "grp-eng" }', `    - ${source}`);

  const COMMON = 'https://login.microsoftonline.com/common/v2.0';
  const PINNED = 'https://login.microsoftonline.com/8f4c-a-real-tenant/v2.0';
  const PERSON = '{ provider: entra, email: alice@example.test, note: n }';

  it('is refused, because the address claim is set by whoever administers the tenant', () => {
    expect(() => load(withIssuer(COMMON, PERSON))).toRefuseWith('groups.address-on-multi-tenant');
  });

  it('is refused for the other two multi-tenant authorities as well', () => {
    for (const authority of ['organizations', 'consumers']) {
      const issuer = `https://login.microsoftonline.com/${authority}/v2.0`;
      expect(() => load(withIssuer(issuer, PERSON))).toRefuseWith('groups.address-on-multi-tenant');
    }
  });

  it('accepts the same source once the issuer names a directory', () => {
    expect(() => load(withIssuer(PINNED, PERSON))).not.toThrow();
  });

  it('accepts a subject under the same unpinned issuer', () => {
    expect(() =>
      load(withIssuer(COMMON, '{ provider: entra, subject: oid-42, note: n }')),
    ).not.toThrow();
  });

  it('is not fooled by a directory that is merely called `common`', () => {
    const issuer = 'https://login.example.test/common-engineering/v2.0';
    expect(() => load(withIssuer(issuer, PERSON))).not.toThrow();
  });
});

describe('resolving an identity into groups', () => {
  const GROUPS = (sources: string) => `
version: 1
auth:
  providers:
    entra:
      type: oidc
      issuer: https://login.example.test/v2.0
      client_id: abc
    letter:
      type: magic-link
mail:
  host: smtp.example.test
  port: 587
  from: docs@example.test
groups:
  engineering:
${sources}
admins:
  groups: [engineering]
forges:
  gh:
    type: github
    app_id: "1"
    private_key: k
    webhook_secret: s
`;

  const resolve = (
    sources: string,
    identity: { subject?: string; email?: string },
    rawGroupIds: string[] = [],
    now = new Date('2026-06-01T12:00:00Z'),
  ) =>
    new ConfigService(load(GROUPS(sources))).resolveInternalGroups(
      'entra',
      rawGroupIds,
      identity,
      now,
    );

  const person = (extra: string) => `    - { provider: entra, subject: oid-42, note: n${extra} }`;

  it('maps a directory group the provider emitted', () => {
    const sources = '    - { provider: entra, id: "grp-eng" }';
    expect(resolve(sources, { subject: 'oid-42' }, ['grp-eng'])).toEqual(['engineering']);
    expect(resolve(sources, { subject: 'oid-42' }, ['grp-other'])).toEqual([]);
  });

  it('matches a person by the provider’s own subject', () => {
    expect(resolve(person(''), { subject: 'oid-42' })).toEqual(['engineering']);
    expect(resolve(person(''), { subject: 'oid-43' })).toEqual([]);
  });

  it('matches a person by address, case-insensitively', () => {
    const sources = '    - { provider: entra, email: Alice@Example.test, note: n }';
    expect(resolve(sources, { email: 'alice@example.test' })).toEqual(['engineering']);
    expect(resolve(sources, { email: 'bob@example.test' })).toEqual([]);
  });

  it('compares a subject case-sensitively, exactly as the principal does', () => {
    expect(resolve(person(''), { subject: 'OID-42' })).toEqual([]);
  });

  it('never matches a source belonging to another provider', () => {
    const sources = '    - { provider: letter, subject: oid-42, note: n }';
    expect(resolve(sources, { subject: 'oid-42' })).toEqual([]);
  });

  it('drops a person whose review date has passed, with nothing having run', () => {
    const past = person(', until: 2026-05-31');
    expect(resolve(past, { subject: 'oid-42' })).toEqual([]);
    const today = person(', until: 2026-06-01');
    expect(resolve(today, { subject: 'oid-42' })).toEqual(['engineering']);
  });

  it('keeps a person whose review date has not, and one who has none', () => {
    expect(resolve(person(', until: 2026-06-02'), { subject: 'oid-42' })).toEqual(['engineering']);
    expect(resolve(person(''), { subject: 'oid-42' })).toEqual(['engineering']);
  });

  it('lets a mapping carry a group whose individual has expired', () => {
    const sources = [
      '    - { provider: entra, subject: oid-42, note: n, until: 2026-05-31 }',
      '    - { provider: entra, id: "grp-eng" }',
    ].join('\n');
    expect(resolve(sources, { subject: 'oid-42' }, ['grp-eng'])).toEqual(['engineering']);
    expect(resolve(sources, { subject: 'oid-42' }, [])).toEqual([]);
  });

  it('honours a review date on a mapping too, not only on a person', () => {
    const dated = '    - { provider: entra, id: "grp-eng", until: 2026-05-31 }';
    expect(resolve(dated, { subject: 'oid-42' }, ['grp-eng'])).toEqual([]);
  });

  it('resolves an identity with no email against an address source', () => {
    const sources = '    - { provider: entra, email: alice@example.test, note: n }';
    expect(resolve(sources, { subject: 'oid-42' })).toEqual([]);
  });
});

describe('a group referencing another', () => {
  const REFS = (groups: string) => `
version: 1
auth:
  providers:
    entra:
      type: oidc
      issuer: https://login.example.test/v2.0
      client_id: abc
groups:
${groups}
admins:
  groups: [engineering]
forges:
  gh:
    type: github
    app_id: "1"
    private_key: k
    webhook_secret: s
`;

  const THREE = REFS(`
  engineering:
    - { provider: entra, id: "grp-eng" }
  platform-ops:
    - { provider: entra, id: "grp-ops" }
  tech:
    - { group: engineering, note: every engineer }
    - { group: platform-ops }
    - { provider: entra, subject: cto-oid, note: the CTO }`);

  const resolve = (yaml: string, rawGroupIds: string[], subject = 'oid-42') =>
    new ConfigService(load(yaml)).resolveInternalGroups(
      'entra',
      rawGroupIds,
      { subject },
      new Date('2026-06-01T12:00:00Z'),
    );

  it('makes a member of the referenced group a member of the referencing one', () => {
    expect(resolve(THREE, ['grp-eng'])).toEqual(['engineering', 'tech']);
    expect(resolve(THREE, ['grp-ops'])).toEqual(['platform-ops', 'tech']);
    expect(resolve(THREE, [], 'cto-oid')).toEqual(['tech']);
    expect(resolve(THREE, [])).toEqual([]);
  });

  it('follows a chain of references', () => {
    const chain = REFS(`
  engineering:
    - { provider: entra, id: "grp-eng" }
  tech:
    - { group: engineering }
  staff:
    - { group: tech }`);
    expect(resolve(chain, ['grp-eng'])).toEqual(['engineering', 'staff', 'tech']);
  });

  it('is written before or after the group it names, either way', () => {
    const later = REFS(`
  tech:
    - { group: engineering }
  engineering:
    - { provider: entra, id: "grp-eng" }`);
    expect(resolve(later, ['grp-eng'])).toEqual(['engineering', 'tech']);
  });

  it('honours a review date on the reference, with nothing having run', () => {
    const dated = REFS(`
  engineering:
    - { provider: entra, id: "grp-eng" }
  tech:
    - { group: engineering, until: 2026-05-31 }`);
    expect(resolve(dated, ['grp-eng'])).toEqual(['engineering']);
  });

  it('counts the sources of the referenced group as its own, each once', () => {
    const twice = REFS(`
  engineering:
    - { provider: entra, id: "grp-eng" }
  platform-ops:
    - { provider: entra, id: "grp-ops" }
    - { group: engineering }
  tech:
    - { group: engineering }
    - { group: platform-ops }`);
    const config = new ConfigService(load(twice));
    expect(config.groupSources('tech').map((s) => s.id)).toEqual(['grp-eng', 'grp-ops']);
    expect(config.groupSources('engineering').map((s) => s.id)).toEqual(['grp-eng']);
    expect(config.groupItems('tech')).toHaveLength(2);
  });

  it('refuses a reference to a group that is not defined, and suggests the near miss', () => {
    const missing = REFS(`
  engineering:
    - { provider: entra, id: "grp-eng" }
  tech:
    - { group: enginering }`);
    expect(() => load(missing)).toRefuseWith('groups.unknown-reference', {
      path: 'groups.tech[0].group',
    });
    const [unknown] = refusalOf(() => load(missing)).issues;
    expect(unknown.text).toContain('"engineering"');
  });

  it('refuses a group that references itself', () => {
    const self = REFS(`
  engineering:
    - { provider: entra, id: "grp-eng" }
    - { group: engineering }`);
    expect(() => load(self)).toRefuseWith('groups.self-reference', {
      path: 'groups.engineering[1].group',
    });
  });

  it('refuses references that lead around in a circle, and names the circle', () => {
    const cycle = REFS(`
  engineering:
    - { provider: entra, id: "grp-eng" }
    - { group: staff }
  tech:
    - { group: engineering }
  staff:
    - { group: tech }`);
    expect(() => load(cycle)).toRefuseWith('groups.reference-cycle');
    const [circle] = refusalOf(() => load(cycle)).issues;
    expect(circle.text).toContain('engineering -> staff -> tech -> engineering');
  });

  it('refuses a reference that also names a provider or a source key', () => {
    const both = REFS(`
  engineering:
    - { provider: entra, id: "grp-eng" }
  tech:
    - { provider: entra, group: engineering }`);
    expect(() => load(both)).toRefuseWith('config.schema');
    const two = REFS(`
  engineering:
    - { provider: entra, id: "grp-eng" }
  tech:
    - { group: engineering, email: a@example.test }`);
    expect(() => load(two)).toRefuseWith('config.schema');
    // A full source with a group key on it would otherwise resolve as the reference
    // and drop the id it names
    for (const key of ['id: grp-x', 'email: a@example.test']) {
      const source = REFS(`
  engineering:
    - { provider: entra, id: "grp-eng" }
  tech:
    - { provider: entra, ${key}, group: engineering }`);
      expect(() => load(source)).toRefuseWith('config.schema');
    }
  });

  it('refuses a reference whose review date is not a date', () => {
    const bad = REFS(`
  engineering:
    - { provider: entra, id: "grp-eng" }
  tech:
    - { group: engineering, until: soon }`);
    expect(() => load(bad)).toRefuseWith('schema.format', { path: 'groups.tech.0.until' });
  });

  it('says a combinator is reserved rather than merely unknown', () => {
    const all = REFS(`
  engineering:
    - { provider: entra, id: "grp-eng" }
  tech:
    - all: [{ group: engineering }]`);
    expect(() => load(all)).toRefuseWith('schema.additionalProperties');
  });

  it('keeps an administrator group populated through a reference', () => {
    const admins = REFS(`
  engineering:
    - { group: platform-ops }
  platform-ops:
    - { provider: entra, id: "grp-ops" }`);
    expect(adminLockout(load(admins).raw)).toBeNull();

    const hollow = REFS(`
  engineering:
    - { group: platform-ops }
  platform-ops: []`);
    expect(adminLockout(load(hollow).raw)).toMatchObject({ code: 'admins.group-empty' });
    expect(adminLockout(load(hollow).raw)?.text).toContain('engineering');
  });

  it('knows which groups reach through it, for a question of where it is used', () => {
    const chain = REFS(`
  engineering:
    - { provider: entra, id: "grp-eng" }
  tech:
    - { group: engineering }
  staff:
    - { group: tech }
  sales:
    - { provider: entra, id: "grp-sales" }`);
    const groups = load(chain).raw.groups;
    expect(referrersOf(groups, 'engineering')).toEqual(['staff', 'tech']);
    expect(referrersOf(groups, 'tech')).toEqual(['staff']);
    expect(referrersOf(groups, 'staff')).toEqual([]);
    expect(referrersOf(groups, 'sales')).toEqual([]);
    expect(referrersOf(undefined, 'engineering')).toEqual([]);
  });

  it('does not move the resolution hash, because only the names decide what ingest accepts', () => {
    const before = load(
      REFS(`
  engineering:
    - { provider: entra, id: "grp-eng" }
  tech:
    - { provider: entra, id: "grp-tech" }`),
    );
    const after = load(
      REFS(`
  engineering:
    - { provider: entra, id: "grp-eng" }
  tech:
    - { group: engineering }`),
    );
    expect(after.resolutionHash).toBe(before.resolutionHash);
  });
});

describe('the resolution hash', () => {
  const base = load(MINIMAL);

  it('is stable across key reordering', () => {
    const reordered = load(
      MINIMAL.replace('admins:\n  groups: [engineering]\n', '').replace(
        'forges:',
        'admins:\n  groups: [engineering]\nforges:',
      ),
    );
    expect(reordered.resolutionHash).toBe(base.resolutionHash);
  });

  it('changes when a group is defined', () => {
    const changed = load(
      MINIMAL.replace(
        'groups:\n',
        'groups:\n  commercial:\n    - { provider: entra, id: "grp-com" }\n',
      ),
    );
    expect(changed.resolutionHash).not.toBe(base.resolutionHash);
  });

  it('does not change when a group only changes who is in it', () => {
    const changed = load(MINIMAL.replace('grp-eng', 'grp-engineering'));
    expect(changed.resolutionHash).toBe(base.resolutionHash);
  });

  it('changes when a provider is added', () => {
    const changed = load(
      MINIMAL.replace(
        '      client_id: abc',
        '      client_id: abc\n    other:\n      type: oidc\n      issuer: https://other.test\n      client_id: xyz',
      ),
    );
    expect(changed.resolutionHash).not.toBe(base.resolutionHash);
  });

  it('changes when default_repository_owner changes', () => {
    const changed = load(
      MINIMAL.replace(
        '    webhook_secret: s\n',
        '    webhook_secret: s\n    default_repository_owner: acme\n',
      ),
    );
    expect(changed.resolutionHash).not.toBe(base.resolutionHash);
  });

  it('does not change when mail is added', () => {
    const changed = load(
      MINIMAL.replace(
        'version: 1',
        'version: 1\nmail:\n  host: smtp.example.test\n  from: "Docs <d@example.test>"',
      ),
    );
    expect(changed.resolutionHash).toBe(base.resolutionHash);
  });

  it('does not change when notify settings change', () => {
    const changed = load(
      MINIMAL.replace(
        'version: 1',
        'version: 1\nmail:\n  host: s\n  from: f\nnotify:\n  stale_after: 12h',
      ),
    );
    expect(changed.resolutionHash).toBe(
      load(MINIMAL.replace('version: 1', 'version: 1\nmail:\n  host: s\n  from: f')).resolutionHash,
    );
  });

  it('does not change when the attribution is switched off', () => {
    const changed = load(MINIMAL.replace('version: 1', 'version: 1\nattribution: false'));
    expect(changed.resolutionHash).toBe(base.resolutionHash);
  });

  it('does not change when the header brand changes', () => {
    const changed = load(MINIMAL.replace('version: 1', 'version: 1\nbrand:\n  name: Acme Docs'));
    expect(changed.resolutionHash).toBe(base.resolutionHash);
  });

  it('is computed from the same subset regardless of how it is reached', () => {
    expect(computeResolutionHash(base.raw, base.primaryForgeId)).toBe(base.resolutionHash);
  });
});

describe('the attribution switch', () => {
  it('is on unless the instance turns it off', () => {
    expect(new ConfigService(load(MINIMAL)).attribution).toBe(true);
    expect(
      new ConfigService(load(MINIMAL.replace('version: 1', 'version: 1\nattribution: false')))
        .attribution,
    ).toBe(false);
  });

  it('is a switch and not a footer anybody can write', () => {
    expect(() =>
      load(MINIMAL.replace('version: 1', 'version: 1\nattribution: Published with Acme')),
    ).toThrow(ConfigError);
  });
});

describe('the header brand', () => {
  const configured = (yaml: string) => new ConfigService(load(yaml)).brand;

  it('is whatever the instance called itself', () => {
    expect(
      configured(
        MINIMAL.replace('version: 1', 'version: 1\nbrand:\n  name: Acme Engineering Docs'),
      ),
    ).toBe('Acme Engineering Docs');
  });

  it('never defaults to this product’s name', () => {
    const unset = configured(MINIMAL);
    expect(unset).not.toMatch(/speicher/i);
    expect(unset).not.toBe('');
  });

  it('falls back to the host the deployment declared, never to the one it was asked for', () => {
    const before = process.env.SPEICHER_PUBLIC_URL;
    try {
      process.env.SPEICHER_PUBLIC_URL = 'https://docs.acme.example/';
      expect(defaultBrand()).toBe('docs.acme.example');
      process.env.SPEICHER_PUBLIC_URL = 'not a url';
      expect(defaultBrand()).toBe(NEUTRAL_BRAND);
      delete process.env.SPEICHER_PUBLIC_URL;
      expect(defaultBrand()).toBe(NEUTRAL_BRAND);
    } finally {
      if (before === undefined) delete process.env.SPEICHER_PUBLIC_URL;
      else process.env.SPEICHER_PUBLIC_URL = before;
    }
  });

  it('treats a blank brand as no brand at all', () => {
    expect(configured(MINIMAL.replace('version: 1', "version: 1\nbrand:\n  name: '   '"))).toBe(
      new ConfigService(load(MINIMAL)).brand,
    );
  });

  it('is text, and nothing but', () => {
    expect(() => load(MINIMAL.replace('version: 1', 'version: 1\nbrand:\n  name: [a, b]'))).toThrow(
      ConfigError,
    );
    expect(() => load(MINIMAL.replace('version: 1', "version: 1\nbrand:\n  name: ''"))).toThrow(
      ConfigError,
    );
  });
});

describe('Entra groups overage', () => {
  it('detects the distributed-claim pointer Entra sends instead of group ids', () => {
    const payload = {
      _claim_names: { groups: 'src1' },
      _claim_sources: {
        src1: { endpoint: 'https://graph.microsoft.com/v1.0/users/x/getMemberObjects' },
      },
    };
    expect(hasGroupsOverage(payload, 'groups')).toBe(true);
  });

  it('does not fire when the claim is simply absent', () => {
    expect(hasGroupsOverage({}, 'groups')).toBe(false);
    expect(hasGroupsOverage({ groups: ['a'] }, 'groups')).toBe(false);
  });

  it('respects a renamed groups claim', () => {
    expect(hasGroupsOverage({ _claim_names: { roles: 'src1' } }, 'groups')).toBe(false);
    expect(hasGroupsOverage({ _claim_names: { roles: 'src1' } }, 'roles')).toBe(true);
  });
});

describe('OIDC discovery mismatch hints', () => {
  it('names the v1.0 endpoint when discovery returns an sts.windows.net issuer', () => {
    const hint = discoveryHint('https://sts.windows.net/5763100d-581e-4b09-b887-eb4fb8a33d30/');
    expect(hint).toContain('/v2.0');
  });

  it('names the multi-tenant endpoint when discovery returns the placeholder', () => {
    const hint = discoveryHint('https://login.microsoftonline.com/{tenantid}/v2.0');
    expect(hint).toContain('tenant GUID');
  });

  it('says nothing extra when the mismatch is not a known shape', () => {
    expect(discoveryHint('https://idp.example.test/')).toBe('');
  });
});

describe('a provider’s display name', () => {
  const named = (value: string) =>
    new ConfigService(
      load(MINIMAL.replace('      type: oidc', `      type: oidc\n      display_name: ${value}`)),
    );

  it('is what the operator wrote', () => {
    expect(named("'Acme Account'").providerName('entra')).toBe('Acme Account');
  });

  it('falls back to the key, so a configuration that predates it is unchanged', () => {
    expect(new ConfigService(load(MINIMAL)).providerName('entra')).toBe('entra');
    expect(named("'   '").providerName('entra')).toBe('entra');
  });

  it('names a provider this instance does not have after itself, rather than nothing', () => {
    expect(new ConfigService(load(MINIMAL)).providerName('gone')).toBe('gone');
  });

  it('decides no principal, so it is not in the resolution hash', () => {
    expect(named("'Acme Account'").resolutionHash).toBe(
      new ConfigService(load(MINIMAL)).resolutionHash,
    );
  });
});

describe('a key the schema has retired', () => {
  const WITH_RETIRED = MINIMAL.replace(
    '      client_id: abc',
    '      client_id: abc\n      team_cache_ttl: 15m',
  );

  it('loads anyway, rather than failing a document that used to be valid', () => {
    expect(() => load(WITH_RETIRED)).not.toThrow();
  });

  it('is gone from the loaded config, not carried as a setting that does nothing', () => {
    const config = new ConfigService(load(WITH_RETIRED));

    expect(config.provider('entra')).not.toHaveProperty('team_cache_ttl');
  });

  it('leaves a key that is still real alone', () => {
    const config = new ConfigService(
      load(MINIMAL.replace('      client_id: abc', '      client_id: abc\n      session_ttl: 30m')),
    );

    expect(config.provider('entra')).toHaveProperty('session_ttl', '30m');
  });

  it('reaches the key under every provider the `*` stands for', () => {
    const twoProviders = MINIMAL.replace(
      '      client_id: abc',
      [
        '      client_id: abc',
        '      team_cache_ttl: 15m',
        '    hub:',
        '      type: github',
        '      client_id: def',
        '      client_secret: s',
        '      team_cache_ttl: 1h',
      ].join('\n'),
    );
    const config = new ConfigService(load(twoProviders));

    expect(config.provider('entra')).not.toHaveProperty('team_cache_ttl');
    expect(config.provider('hub')).not.toHaveProperty('team_cache_ttl');
  });
});

describe("a github group source's id", () => {
  const withId = (id: string) =>
    `
version: 1
auth:
  providers:
    hub:
      type: github
      client_id: abc
      client_secret: s
groups:
  engineering:
    - { provider: hub, id: ${id} }
admins:
  groups: [engineering]
`;

  it('is a team', () => {
    expect(() => load(withId('acme/platform'))).not.toThrow();
  });

  it('is refused when it names only an organisation', () => {
    // Accepted by the schema, reaches nobody, and would otherwise surface much later
    // as a directory warning during ingest
    expect(() => load(withId('acme'))).toRefuseWith('groups.github-team-invalid');
  });

  it('is refused when the organisation or the slug is missing', () => {
    expect(() => load(withId("'/platform'"))).toRefuseWith('groups.github-team-invalid');
    expect(() => load(withId("'acme/'"))).toRefuseWith('groups.github-team-invalid');
  });

  it('is refused when it goes a level deeper than a team', () => {
    expect(() => load(withId('acme/sub/team'))).toRefuseWith('groups.github-team-invalid');
  });

  it("says nothing of the sort about another provider's group ids", () => {
    expect(() => load(MINIMAL)).not.toThrow();
  });
});

describe('a GitHub sign-in provider', () => {
  const GITHUB_PROVIDER = `
version: 1
auth:
  providers:
    hub:
      type: github
      client_id: abc
      client_secret: s
groups:
  engineering:
    - { provider: hub, id: acme/platform }
admins:
  groups: [engineering]
`;

  it('loads with a client id and secret', () => {
    expect(() => load(GITHUB_PROVIDER)).not.toThrow();
  });

  it('refuses one with no client secret, which would fail only at the token exchange', () => {
    // Optional in the schema, mandatory in fact: without it GitHub refuses every
    // code and the reader is told the sign-in could not be completed
    expect(() => load(GITHUB_PROVIDER.replace('      client_secret: s\n', ''))).toRefuseWith(
      'providers.client-secret-missing',
    );
  });
});

describe('an Entra ID sign-in provider', () => {
  const ENTRA_PROVIDER = `
version: 1
auth:
  providers:
    entra:
      issuer: https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0
      client_id: abc
      client_secret: s
groups:
  engineering:
    - { provider: entra, id: 11111111-1111-1111-1111-111111111111 }
admins:
  groups: [engineering]
`;

  it('loads with a client id and secret', () => {
    expect(() => load(ENTRA_PROVIDER)).not.toThrow();
  });

  it('refuses one with no client secret, which Entra demands at the token exchange', () => {
    expect(() => load(ENTRA_PROVIDER.replace('      client_secret: s\n', ''))).toRefuseWith(
      'providers.client-secret-missing',
    );
  });

  it.each([
    'https://login.microsoftonline.us/t/v2.0',
    'https://login.partner.microsoftonline.cn/t/v2.0',
    'https://acme.ciamlogin.com/t/v2.0',
  ])('treats %s as Entra too', (issuer) => {
    const yaml = ENTRA_PROVIDER.replace(/issuer: .*/, `issuer: ${issuer}`).replace(
      '      client_secret: s\n',
      '',
    );
    expect(() => load(yaml)).toRefuseWith('providers.client-secret-missing');
  });

  it('leaves the secret optional for other OIDC issuers', () => {
    const yaml = ENTRA_PROVIDER.replace(/issuer: .*/, 'issuer: https://idp.example.com').replace(
      '      client_secret: s\n',
      '',
    );
    expect(() => load(yaml)).not.toThrow();
  });
});

describe('a GitHub directory', () => {
  const GITHUB = `
version: 1
auth:
  providers:
    hub:
      type: github
      client_id: abc
      client_secret: s
      directory:
        type: github
        app_id: "2"
        private_key: a-pem
groups:
  engineering:
    - { provider: hub, id: acme/platform }
admins:
  groups: [engineering]
forges:
  gh:
    type: github
    app_id: "1"
    private_key: k
    webhook_secret: s
`;

  it('loads with its own App', () => {
    expect(() => load(GITHUB)).not.toThrow();
  });

  it('refuses one with no App of its own to read an organisation through', () => {
    // Borrowing a content source's App would mean granting *that* credential
    // Members: Read-only, so the directory is made to name its own
    expect(() => load(GITHUB.replace('        app_id: "2"\n', ''))).toRefuseWith(
      'providers.directory-key-missing',
    );
    expect(() => load(GITHUB.replace('        private_key: a-pem\n', ''))).toRefuseWith(
      'providers.directory-key-missing',
    );
  });

  it('does not take a content source standing in for one', () => {
    // A github forge is configured in GITHUB, and is still not enough
    const noCredentials = GITHUB.replace('        app_id: "2"\n', '').replace(
      '        private_key: a-pem\n',
      '',
    );

    expect(() => load(noCredentials)).toRefuseWith('providers.directory-key-missing');
  });

  it('refuses Graph credentials, which do nothing here', () => {
    expect(() =>
      load(GITHUB.replace('        type: github', '        type: github\n        client_id: c')),
    ).toRefuseWith('providers.directory-foreign-key');
    expect(() =>
      load(GITHUB.replace('        type: github', '        type: github\n        tenant_id: t')),
    ).toRefuseWith('providers.directory-foreign-key');
  });

  it('refuses a Graph directory on a github provider', () => {
    expect(() =>
      load(GITHUB.replace('        type: github\n', '        type: graph\n')),
    ).toRefuseWith('providers.directory-wrong-type');
  });

  it('says nothing about an App on a github provider with no directory', () => {
    const noDirectory = GITHUB.replace(
      '      directory:\n        type: github\n        app_id: "2"\n        private_key: a-pem\n',
      '',
    );
    expect(() => load(noDirectory)).not.toThrow();
  });
});
