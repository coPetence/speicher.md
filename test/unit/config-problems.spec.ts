/*
  Every config problem, found from a document that has it

  One row per code: the smallest change that produces it, run through what a save
  runs. A row proves the check still fires and that its wording keeps two rules:
  the YAML wording carries no links, which a terminal cannot follow, and a problem
  about a key has a dashboard wording, because the YAML one leads with the key and
  the dashboard shows the problem under that key's field instead.
*/
import { ConfigProblem, PROBLEM_CODES, ProblemCode } from '../../src/common/config-problems';
import { ConfigError } from '../../src/common/errors';
import { resolveAzureOptions } from '../../src/assets/azure-blob-store';
import { resolveS3Options } from '../../src/assets/s3-blob-store';
import { adminLockout } from '../../src/config/checks/admins';
import { checkGroups } from '../../src/config/checks/groups';
import { validateForSave } from '../../src/config/loader';
import { loadInstanceConfig, loadInstanceConfigFromFile } from '../../src/config/parser';
import { exportConfig } from '../../src/dashboard/configurator/config-form/export';
import { AssetsConfig, InstanceConfig } from '../../src/config/types';

const BASE = `
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
`;

const GITHUB_FORGE = `forges:
  gh:
    type: github
    app_id: "1"
    private_key: k
    webhook_secret: s
`;

const GIT_FORGE = `forges:
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

const GIT = `${BASE}${GIT_FORGE}`;
const MAIL = 'mail:\n  host: smtp.example.test\n  from: docs@example.test\n';
const LINKS = '    links:\n      type: magic-link\n';

/** BASE with a line added under a key that ends a line of BASE */
const under = (anchor: string, lines: string, base = BASE) => {
  if (!base.includes(anchor)) throw new Error(`the fixture has no ${JSON.stringify(anchor)}`);
  return base.replace(anchor, `${anchor}${lines}`);
};

const ENTRA_ISSUER = (yaml: string) =>
  yaml.replace('https://login.example.test/v2.0', 'https://login.microsoftonline.com/t/v2.0');

const GRAPH = (lines: string) =>
  under('      client_id: abc\n', `      directory:\n        type: graph\n${lines}`);

const GITHUB_PROVIDER = (lines: string) =>
  under(
    '  providers:\n',
    `    hub:\n      type: github\n      client_id: c\n      client_secret: s\n${lines}`,
  );

const GITHUB_DIRECTORY =
  '      directory:\n        type: github\n        app_id: "2"\n        private_key: a-pem\n';

const refs = (groups: string) =>
  BASE.replace(/groups:\n {2}engineering:\n.*\n/, `groups:\n${groups}`);

/** What a save would refuse the document for: what the save itself runs */
function savedProblems(yaml: string): ConfigProblem[] {
  try {
    validateForSave(yaml);
    return [];
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return [err.summary, ...err.issues];
  }
}

/** The load's problems, else the lockout: for documents that would also fail later checks */
function loadedProblems(yaml: string): ConfigProblem[] {
  try {
    const lockout = adminLockout(loadInstanceConfig(yaml).raw);
    return lockout ? [lockout] : [];
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return [err.summary, ...err.issues];
  }
}

function thrownProblems(run: () => unknown): ConfigProblem[] {
  try {
    run();
    return [];
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return [err.summary, ...err.issues];
  }
}

const CASES: [ProblemCode, () => ConfigProblem[]][] = [
  [
    'config.unreadable',
    () => thrownProblems(() => loadInstanceConfigFromFile('/nonexistent/instance.yaml')),
  ],
  ['config.export-unparseable', () => thrownProblems(() => exportConfig('version: 1\nauth: [\n'))],
  ['config.yaml-invalid', () => loadedProblems('version: 1\nauth: [\n')],
  ['config.schema', () => loadedProblems(`${BASE}unknown: 1\n`)],
  [
    'config.env-missing',
    () => loadedProblems(BASE.replace('client_id: abc', 'client_id: ${NOPE}')),
  ],
  ['env.unset', () => loadedProblems(BASE.replace('client_id: abc', 'client_id: ${NOPE}'))],
  [
    'config.inconsistent',
    () => loadedProblems(BASE.replace('provider: entra, id', 'provider: nope, id')),
  ],
  ['config.private-key-unreadable', () => savedProblems(`${BASE}${GITHUB_FORGE}`)],
  ['github.private-key-unreadable', () => savedProblems(`${BASE}${GITHUB_FORGE}`)],
  [
    'config.host-key-missing',
    () =>
      savedProblems(GIT.replace('git.example.test ssh-ed25519', 'other.example.test ssh-ed25519')),
  ],
  [
    'forges.host-key-missing',
    () =>
      savedProblems(GIT.replace('git.example.test ssh-ed25519', 'other.example.test ssh-ed25519')),
  ],

  [
    'names.reserved',
    () => loadedProblems(under('groups:\n', '  public:\n    - { provider: entra, id: "x" }\n')),
  ],
  [
    'names.case-collision',
    () =>
      loadedProblems(under('groups:\n', '  Engineering:\n    - { provider: entra, id: "x" }\n')),
  ],

  ['admins.none', () => loadedProblems('version: 1\n')],
  [
    'admins.group-empty',
    () =>
      loadedProblems(
        BASE.replace('    - { provider: entra, id: "grp-eng" }\n', '').replace(
          'engineering:\n',
          'engineering: []\n',
        ),
      ),
  ],
  [
    'admins.unknown-group',
    () => loadedProblems(BASE.replace('groups: [engineering]', 'groups: [nope]')),
  ],
  [
    'admins.user-no-provider',
    () => loadedProblems('version: 1\nadmins:\n  users:\n    - { email: ada@example.test }\n'),
  ],
  [
    'admins.user-ambiguous-provider',
    () =>
      loadedProblems(
        under(
          '  providers:\n',
          '    partner:\n      type: oidc\n      issuer: https://partner.example.test\n      client_id: d\n',
        ).concat('  users:\n    - { email: ada@example.test }\n'),
      ),
  ],
  [
    'admins.unknown-provider',
    () => loadedProblems(`${BASE}  users:\n    - { provider: nope, email: ada@example.test }\n`),
  ],

  ['providers.magic-link-needs-mail', () => loadedProblems(under('  providers:\n', LINKS))],
  [
    'providers.unknown-default',
    () => loadedProblems(under('auth:\n', '  default_provider: nope\n')),
  ],
  ['providers.client-secret-missing', () => loadedProblems(ENTRA_ISSUER(BASE))],
  [
    'providers.directory-wrong-type',
    () => loadedProblems(GITHUB_PROVIDER(GITHUB_DIRECTORY.replace('type: github', 'type: graph'))),
  ],
  [
    'providers.directory-foreign-key',
    () => loadedProblems(GITHUB_PROVIDER(`${GITHUB_DIRECTORY}        tenant_id: t\n`)),
  ],
  ['providers.directory-key-missing', () => loadedProblems(GRAPH('        tenant_id: t\n'))],
  [
    'providers.directory-needs-oid',
    () =>
      loadedProblems(
        GRAPH('        tenant_id: t\n        client_id: c\n        client_secret: s\n'),
      ),
  ],

  [
    'groups.unknown-provider',
    () => loadedProblems(BASE.replace('provider: entra, id', 'provider: nope, id')),
  ],
  [
    'groups.domain-needs-magic-link',
    () => loadedProblems(BASE.replace('id: "grp-eng"', 'domain: "acme.test"')),
  ],
  [
    'groups.id-with-magic-link',
    () =>
      loadedProblems(
        `${under('  providers:\n', LINKS).replace('provider: entra, id', 'provider: links, id')}${MAIL}`,
      ),
  ],
  [
    'groups.github-team-invalid',
    () =>
      loadedProblems(
        GITHUB_PROVIDER('').replace('provider: entra, id: "grp-eng"', 'provider: hub, id: acme'),
      ),
  ],
  [
    // The schema refuses a malformed date before this check is reached, so the
    // check is run on the parsed document directly
    'groups.until-invalid',
    () => {
      const problems: ConfigProblem[] = [];
      checkGroups(
        {
          version: 1,
          auth: {
            providers: { entra: { type: 'oidc', issuer: 'https://x.test', client_id: 'c' } },
          },
          groups: { team: [{ provider: 'entra', subject: 's', note: 'n', until: 'soon' }] },
        } as unknown as InstanceConfig,
        problems,
      );
      return problems;
    },
  ],
  [
    'groups.address-on-multi-tenant',
    () =>
      loadedProblems(
        BASE.replace(
          'https://login.example.test/v2.0',
          'https://login.microsoftonline.com/common/v2.0',
        )
          .replace('id: "grp-eng"', 'email: alice@example.test, note: n')
          .replace('      client_id: abc\n', '      client_id: abc\n      client_secret: s\n'),
      ),
  ],
  [
    'groups.self-reference',
    () =>
      loadedProblems(
        under('    - { provider: entra, id: "grp-eng" }\n', '    - { group: engineering }\n'),
      ),
  ],
  [
    'groups.unknown-reference',
    () => loadedProblems(under('groups:\n', '  tech:\n    - { group: enginering }\n')),
  ],
  [
    'groups.reference-cycle',
    () =>
      loadedProblems(
        refs(
          '  engineering:\n    - { provider: entra, id: "grp-eng" }\n    - { group: staff }\n  staff:\n    - { group: engineering }\n',
        ),
      ),
  ],

  [
    'brand.image-invalid',
    () => loadedProblems(`${BASE}brand:\n  logo: "data:image/png;base64,AAAA"\n`),
  ],
  [
    'analytics.timezone-unknown',
    () => loadedProblems(`${BASE}analytics:\n  timezone: Mars/Olympus\n`),
  ],

  [
    'forges.primary-ambiguous',
    () =>
      loadedProblems(
        GIT.replace('    type: git\n', '    type: git\n    primary: true\n').concat(
          '  gl:\n    type: gitlab\n    primary: true\n    token: t\n    webhook_secret: s\n',
        ),
      ),
  ],
  [
    'forges.primary-missing',
    () =>
      loadedProblems(GIT.concat('  gl:\n    type: gitlab\n    token: t\n    webhook_secret: s\n')),
  ],
  [
    'forges.segment-reserved',
    () =>
      loadedProblems(
        GIT.replace('    type: git\n', '    type: git\n    primary: true\n').concat(
          '  api:\n    type: gitlab\n    token: t\n    webhook_secret: s\n',
        ),
      ),
  ],
  [
    'forges.segment-taken',
    () =>
      loadedProblems(
        GIT.replace('    type: git\n', '    type: git\n    primary: true\n')
          .replace('- id: handbook', '- id: gl')
          .concat('  gl:\n    type: gitlab\n    token: t\n    webhook_secret: s\n'),
      ),
  ],
  [
    'forges.repos-on-non-git',
    () =>
      loadedProblems(
        `${BASE}${GITHUB_FORGE}    repos:\n      - { id: docs, url: https://git.example.test/ops/docs.git }\n`,
      ),
  ],
  [
    'forges.webhook-secret-on-git',
    () => loadedProblems(GIT.replace('    poll_interval: 24h', '    webhook_secret: s')),
  ],
  [
    'forges.app-key-on-git',
    () => loadedProblems(GIT.replace('    poll_interval: 24h', '    app_id: "1"')),
  ],
  [
    'forges.poll-interval-too-short',
    () => loadedProblems(GIT.replace('poll_interval: 24h', 'poll_interval: 10s')),
  ],
  [
    'forges.repo-id-taken',
    () =>
      loadedProblems(
        `${GIT}      - id: Handbook\n        url: ssh://git@git.example.test/ops/other.git\n        deploy_key: k\n        slug: other\n`,
      ),
  ],
  [
    'forges.repo-url-no-owner',
    () =>
      loadedProblems(
        GIT.replace('git.example.test/ops/handbook.git', 'git.example.test/handbook.git'),
      ),
  ],
  [
    'forges.repo-slug-empty',
    () =>
      loadedProblems(
        GIT.replace('        deploy_key:', '        slug: "---"\n        deploy_key:'),
      ),
  ],
  [
    'forges.repo-slug-taken',
    () =>
      loadedProblems(
        `${GIT}      - id: second\n        slug: handbook\n        url: ssh://git@git.example.test/ops/second.git\n        deploy_key: k\n`,
      ),
  ],
  [
    'forges.ssh-needs-deploy-key',
    () =>
      loadedProblems(
        GIT.replace('        deploy_key: "-----BEGIN OPENSSH PRIVATE KEY-----"\n', ''),
      ),
  ],
  [
    'forges.ssh-needs-known-hosts',
    () => loadedProblems(GIT.replace('    known_hosts: "git.example.test ssh-ed25519 AAAA"\n', '')),
  ],
  [
    'forges.token-on-ssh',
    () =>
      loadedProblems(GIT.replace('        deploy_key:', '        token: t\n        deploy_key:')),
  ],
  [
    'forges.https-needs-token',
    () =>
      loadedProblems(
        GIT.replace('ssh://git@git.example.test', 'https://git.example.test').replace(
          '        deploy_key: "-----BEGIN OPENSSH PRIVATE KEY-----"\n',
          '',
        ),
      ),
  ],
  [
    'forges.deploy-key-on-https',
    () =>
      loadedProblems(
        GIT.replace('ssh://git@git.example.test', 'https://git.example.test').replace(
          '        deploy_key:',
          '        token: t\n        deploy_key:',
        ),
      ),
  ],

  ['assets.misconfigured', () => thrownProblems(() => resolveS3Options({} as AssetsConfig))],
  ['assets.key-missing', () => thrownProblems(() => resolveS3Options({} as AssetsConfig))],
  [
    'assets.auth-unknown',
    () =>
      thrownProblems(() =>
        resolveAzureOptions({
          account: 'a',
          container: 'c',
          auth: 'nope',
        } as unknown as AssetsConfig),
      ),
  ],
];

/**
 * Codes no document produces, each with the spec that makes it happen: they come
 * from the database, the environment, the runtime, or a command
 */
const ELSEWHERE: Record<string, string> = {
  'config.no-version-loads': 'the database holding no version that loads; config-source.spec',
  'config.version-conflict': 'two saves racing; no spec yet',
  'config.source-invalid': 'SPEICHER_CONFIG_SOURCE; env.spec',
  'brand.image-not-stored': 'the brand image store; brand-images.spec',
  'azure.credential-unavailable': 'the Azure runtime; azure-credential.spec',
  'azure.credential-unknown-kind':
    'a credential kind added without its case; azure-credential.spec',
};

describe('every config problem', () => {
  it('is found here from a document, or named as one no document can produce', () => {
    const covered = [...CASES.map(([code]) => code), ...Object.keys(ELSEWHERE)];
    expect([...covered].sort()).toEqual([...PROBLEM_CODES].sort());
  });

  it.each(CASES)('%s: is found, and worded for the YAML and the dashboard apart', (code, run) => {
    const found = run().filter((p) => p.code === code);
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) {
      // Links are for the dashboard; the YAML wording is read in a terminal
      expect(p.text).not.toContain('](');
      if (p.path === null) continue;
      // The YAML wording leads with the key, which the dashboard shows as a field
      expect(p.dashboard).toBeDefined();
      expect(p.dashboard).not.toMatch(
        /\b(admins|auth|groups|forges|brand|assets|analytics|mail)\.[a-z_]/,
      );
    }
  });
});
