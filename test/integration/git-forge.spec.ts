import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { QueryTypes } from 'sequelize';

import { FilesystemBlobStore } from '../../src/assets/blob-store';
import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfig } from '../../src/config/parser';
import { Forge, Repo, RepoSlugHistory, initModels } from '../../src/db/models';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { RemoteRepo } from '../../src/forge/driver';
import { GitInvocation } from '../../src/forge/credential';
import { GitDriver } from '../../src/forge/git/git.driver';
import { ForgeRegistry } from '../../src/forge/registry';
import { WebhookController } from '../../src/forge/webhook.controller';
import { IngestService } from '../../src/ingest/ingest.service';
import { RegistrationService } from '../../src/jobs/registration.service';
import { SyncService } from '../../src/jobs/sync.service';
import { Mailer } from '../../src/notify/mailer';
import { NotifyService } from '../../src/notify/notify.service';
import { RoutingService } from '../../src/content-reader/routing';
import { defaultTenantId, truncateAll } from '../helpers/harness';

const GIT_IDENTITY = [
  '-c',
  'user.email=fixture@speicher.test',
  '-c',
  'user.name=Speicher Fixture',
  '-c',
  'commit.gpgsign=false',
];

function git(args: string[], cwd: string): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

const temporary: string[] = [];

function createOrigin(branch: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'speicher-git-origin-'));
  temporary.push(dir);
  git(['init', '--quiet', `--initial-branch=${branch}`], dir);
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  git(['add', '-A'], dir);
  git(['commit', '--quiet', '-m', 'initial'], dir);
  return dir;
}

const REPO_CONFIG = `version: 1
access:
  groups: [engineering]
ingest_root: docs
`;

function instanceYaml(repos: string): string {
  return `
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
${repos}`;
}

function repoEntry(options: {
  id: string;
  slug?: string;
  branch?: string;
  pollInterval?: string;
}): string {
  return [
    `      - id: ${options.id}`,
    `        url: ssh://git@git.example.test/ops/${options.id}.git`,
    `        deploy_key: "-----BEGIN OPENSSH PRIVATE KEY-----"`,
    options.slug ? `        slug: ${options.slug}` : null,
    options.branch ? `        branch: ${options.branch}` : null,
    options.pollInterval ? `        poll_interval: ${options.pollInterval}` : null,
  ]
    .filter(Boolean)
    .join('\n')
    .concat('\n');
}

class LocalGitDriver extends GitDriver {
  constructor(
    key: string,
    config: ConfigService,
    private readonly origins: Record<string, string>,
  ) {
    super(key, config.forge(key)!);
  }

  protected override async withRemote<T>(
    repo: RemoteRepo,
    run: (remote: GitInvocation) => Promise<T>,
  ): Promise<T> {
    const origin = this.origins[repo.forgeRepoId];
    if (!origin) throw new Error(`no local origin for ${repo.forgeRepoId}`);
    return run({ authenticatedUrl: `file://${origin}` });
  }
}

class LocalRegistry extends ForgeRegistry {
  constructor(
    config: ConfigService,
    private readonly local: LocalGitDriver,
  ) {
    super(config);
  }
  driver(): LocalGitDriver {
    return this.local;
  }
  async driverForRepo(): Promise<LocalGitDriver> {
    return this.local;
  }
}

interface Fixture {
  config: ConfigService;
  registry: LocalRegistry;
  registration: RegistrationService;
  sync: SyncService;
  tenantId: string;
}

async function build(repos: string, origins: Record<string, string>): Promise<Fixture> {
  const sequelize = getSequelize();
  const config = new ConfigService(loadInstanceConfig(instanceYaml(repos)));
  const tenantId = await defaultTenantId();

  const blobRoot = mkdtempSync(join(tmpdir(), 'speicher-blobs-'));
  temporary.push(blobRoot);
  process.env.SPEICHER_ASSET_PATH = blobRoot;

  const driver = new LocalGitDriver('internal', config, origins);
  const registry = new LocalRegistry(config, driver);
  await registry.syncForgeRows(tenantId);

  const routing = new RoutingService(config, sequelize);
  const registration = new RegistrationService(config, registry, routing);
  const sync = new SyncService(
    registry,
    new IngestService(config, new FilesystemBlobStore(blobRoot), sequelize),
    routing,
    new NotifyService(config, new Mailer(config)),
  );
  return { config, registry, registration, sync, tenantId };
}

async function repoRow(slug: string): Promise<Repo> {
  const repo = await Repo.findOne({ where: { slug } });
  if (!repo) throw new Error(`no repo row for ${slug}`);
  return repo;
}

async function slugsOf(repoId: string): Promise<string[]> {
  const rows = await getSequelize().query<{ slug_path: string }>(
    `SELECT slug_path FROM documents WHERE repo_id = :repoId ORDER BY slug_path`,
    { type: QueryTypes.SELECT, replacements: { repoId } },
  );
  return rows.map((r) => r.slug_path);
}

beforeAll(async () => {
  const sequelize = getSequelize();
  initModels(sequelize);
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
  await closeSequelize();
});

describe('registration from config', () => {
  it('registers what config names and syncs it from the real remote', async () => {
    const origin = createOrigin('main', {
      '.speicher.yaml': REPO_CONFIG,
      'docs/index.md': '# Handbook\n\nThe landing page.\n',
      'docs/01-setup.md': '# Setup\n',
    });
    const fixture = await build(repoEntry({ id: 'handbook' }), { handbook: origin });

    await fixture.registration.syncRepoRowsForInstallation(fixture.tenantId, null, 'internal');

    const repo = await repoRow('handbook');
    expect(repo.forge_repo_id).toBe('handbook');
    expect(repo.namespace).toBe('ops');
    expect(repo.branch).toBe('');

    const result = await fixture.sync.syncRepo(repo.id, 'reconciler');

    expect(result?.status).toBe('ok');
    expect(await slugsOf(repo.id)).toEqual(['', 'setup']);
    const synced = await repoRow('handbook');
    expect(synced.branch).toBe('main');
    expect(synced.last_sha).toBe(git(['rev-parse', 'HEAD'], origin));
  });

  it('takes an id in the shape the forge names it, and serves a path that is not it', async () => {
    const origin = createOrigin('main', {
      '.speicher.yaml': REPO_CONFIG,
      'docs/index.md': '# Design system\n',
    });
    const fixture = await build(repoEntry({ id: 'Design.System' }), { 'Design.System': origin });

    await fixture.registration.syncRepoRowsForInstallation(fixture.tenantId, null, 'internal');

    const repo = await repoRow('design-system');
    expect(repo.forge_repo_id).toBe('Design.System');

    const result = await fixture.sync.syncRepo(repo.id, 'reconciler');
    expect(result?.status).toBe('ok');
    expect(await slugsOf(repo.id)).toEqual(['']);
  });

  it('carries the access from the commit, not from a directory someone staged', async () => {
    const origin = createOrigin('main', {
      '.speicher.yaml': REPO_CONFIG,
      'docs/index.md': '# Handbook\n',
    });
    const fixture = await build(repoEntry({ id: 'access-check' }), { 'access-check': origin });
    await fixture.registration.syncRepoRowsForInstallation(fixture.tenantId, null, 'internal');
    await fixture.sync.syncRepo((await repoRow('access-check')).id, 'reconciler');

    const rows = await getSequelize().query<{ effective_principals: string[] }>(
      `SELECT effective_principals FROM documents WHERE slug_path = ''`,
      { type: QueryTypes.SELECT },
    );
    expect(rows[0].effective_principals).toEqual(['group:engineering']);
  });

  it('honours a configured branch over the remote HEAD', async () => {
    const origin = createOrigin('main', {
      '.speicher.yaml': REPO_CONFIG,
      'docs/index.md': '# On main\n',
    });
    git(['checkout', '--quiet', '-b', 'docs'], origin);
    writeFileSync(join(origin, 'docs/index.md'), '# On docs\n');
    writeFileSync(join(origin, 'docs/only-here.md'), '# Only on docs\n');
    git(['add', '-A'], origin);
    git(['commit', '--quiet', '-m', 'docs branch'], origin);
    git(['checkout', '--quiet', 'main'], origin);

    const fixture = await build(repoEntry({ id: 'branched', branch: 'docs' }), {
      branched: origin,
    });
    await fixture.registration.syncRepoRowsForInstallation(fixture.tenantId, null, 'internal');
    const repo = await repoRow('branched');
    await fixture.sync.syncRepo(repo.id, 'reconciler');

    expect(await slugsOf(repo.id)).toEqual(['', 'only-here']);
  });
});

describe('a repository that changes in config', () => {
  it('keeps the old path alive when the slug changes', async () => {
    const origin = createOrigin('main', {
      '.speicher.yaml': REPO_CONFIG,
      'docs/index.md': '# Handbook\n',
    });
    const before = await build(repoEntry({ id: 'renamed' }), { renamed: origin });
    await before.registration.syncRepoRowsForInstallation(before.tenantId, null, 'internal');
    const repoId = (await repoRow('renamed')).id;

    const after = await build(repoEntry({ id: 'renamed', slug: 'company-handbook' }), {
      renamed: origin,
    });
    await after.registration.syncRepoRowsForInstallation(after.tenantId, null, 'internal');

    const renamed = await Repo.findByPk(repoId);
    expect(renamed!.slug).toBe('company-handbook');
    const history = await RepoSlugHistory.findAll({ where: { repo_id: repoId } });
    expect(history.map((h) => h.old_slug)).toEqual(['renamed']);
  });

  it('reports a repository config no longer names, so removing it can retire it', async () => {
    const origin = createOrigin('main', {
      '.speicher.yaml': REPO_CONFIG,
      'docs/index.md': '# Handbook\n',
    });
    const before = await build(repoEntry({ id: 'kept' }).concat(repoEntry({ id: 'runbooks' })), {
      kept: origin,
      runbooks: origin,
    });
    await before.registration.syncRepoRowsForInstallation(before.tenantId, null, 'internal');
    expect(await Repo.count()).toBe(2);

    const after = await build(repoEntry({ id: 'kept' }), { kept: origin });
    const orphans = await after.registration.unconfiguredRepoIds(after.tenantId, 'internal');

    expect(orphans).toEqual([(await repoRow('runbooks')).id]);
  });

  it('reports nothing for a forge whose repo list comes from an API', async () => {
    const origin = createOrigin('main', {
      '.speicher.yaml': REPO_CONFIG,
      'docs/index.md': '# Handbook\n',
    });
    const fixture = await build(repoEntry({ id: 'api-forge' }), { 'api-forge': origin });
    await Forge.create({
      tenant_id: fixture.tenantId,
      key: 'gh',
      type: 'github',
      is_primary: false,
      config: {},
    });
    expect(await fixture.registration.unconfiguredRepoIds(fixture.tenantId, 'gh')).toEqual([]);
  });
});

describe('polling', () => {
  it("follows the repository's own interval rather than the instance-wide one", async () => {
    const origin = createOrigin('main', {
      '.speicher.yaml': REPO_CONFIG,
      'docs/index.md': '# Handbook\n',
    });
    const fixture = await build(
      repoEntry({ id: 'poll-daily' }).concat(repoEntry({ id: 'runbooks', pollInterval: '5m' })),
      { 'poll-daily': origin, runbooks: origin },
    );
    await fixture.registration.syncRepoRowsForInstallation(fixture.tenantId, null, 'internal');

    expect((await repoRow('poll-daily')).poll_interval_ms).toBe(86_400_000);
    expect((await repoRow('runbooks')).poll_interval_ms).toBe(300_000);

    const hourAgo = new Date(Date.now() - 3_600_000);
    await Repo.update({ last_run_at: hourAgo, has_config: true }, { where: {} });

    const due = await fixture.sync.dueForReconcile(900_000);

    expect(due.map((d) => d.id)).toEqual([(await repoRow('runbooks')).id]);
  });

  it('picks up a repository that has never run, which no push will ever announce', async () => {
    const origin = createOrigin('main', {
      '.speicher.yaml': REPO_CONFIG,
      'docs/index.md': '# Handbook\n',
    });
    const fixture = await build(repoEntry({ id: 'never-run' }), { 'never-run': origin });
    await fixture.registration.syncRepoRowsForInstallation(fixture.tenantId, null, 'internal');

    expect((await repoRow('never-run')).has_config).toBe(false);
    const due = await fixture.sync.dueForReconcile(900_000);
    expect(due.map((d) => d.id)).toEqual([(await repoRow('never-run')).id]);
  });

  it('leaves an unpublished repository alone once it has been looked at', async () => {
    const origin = createOrigin('main', { 'docs/index.md': '# No config here\n' });
    const fixture = await build(repoEntry({ id: 'unpublished' }), { unpublished: origin });
    await fixture.registration.syncRepoRowsForInstallation(fixture.tenantId, null, 'internal');
    const repoId = (await repoRow('unpublished')).id;

    await fixture.sync.syncRepo(repoId, 'reconciler');

    const repo = await Repo.findByPk(repoId);
    expect(repo!.has_config).toBe(false);
    expect(repo!.last_run_at).not.toBeNull();
    expect(await fixture.sync.dueForReconcile(900_000)).toEqual([]);
  });
});

describe('the webhook endpoint', () => {
  it('does not exist for a forge that takes no deliveries', async () => {
    const origin = createOrigin('main', {
      '.speicher.yaml': REPO_CONFIG,
      'docs/index.md': '# Handbook\n',
    });
    const fixture = await build(repoEntry({ id: 'no-hooks' }), { 'no-hooks': origin });
    const registry = new ForgeRegistry(fixture.config);
    const controller = new WebhookController(registry, null as never, null as never);

    let status = 0;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      end() {},
    };

    await controller.receive('internal', { rawBody: Buffer.from('{}') } as never, res as never, {});

    expect(status).toBe(404);
    expect(registry.driver('internal')!.acceptsWebhooks).toBe(false);
  });
});
