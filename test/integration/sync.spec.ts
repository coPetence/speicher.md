import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { QueryTypes } from 'sequelize';

import { FilesystemBlobStore } from '../../src/assets/blob-store';
import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import { migrateUp } from '../../src/db/migrate';
import { Forge, Repo, initModels } from '../../src/db/models';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { ForgeAction, ForgeDriver, RemoteInstallation, RemoteRepo } from '../../src/forge/driver';
import type { WebhookVerification } from '../../src/webhooks/signed-delivery';
import {
  CLONE_ROOT,
  CheckedOutCommit,
  CommitTree,
  checkoutCommit,
  resolveRemoteHead,
} from '../../src/forge/git';
import { ForgeRegistry } from '../../src/forge/registry';
import { IngestService } from '../../src/ingest/ingest.service';
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

function write(root: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
}

function createOrigin(branch: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'speicher-origin-'));
  git(['init', '--quiet', `--initial-branch=${branch}`], dir);
  // An origin without files stays without commits, like a repo created and never pushed to
  if (Object.keys(files).length === 0) return dir;
  write(dir, files);
  git(['add', '-A'], dir);
  git(['commit', '--quiet', '-m', 'initial'], dir);
  return dir;
}

function commit(
  dir: string,
  message: string,
  files: Record<string, string>,
  removed: string[] = [],
): string {
  write(dir, files);
  for (const path of removed) git(['rm', '--quiet', path], dir);
  git(['add', '-A'], dir);
  git(['commit', '--quiet', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

const REPO_CONFIG = `version: 1
access:
  groups: [engineering]
ingest_root: docs
maintainers:
  groups: [engineering]
`;

class LocalOriginDriver implements ForgeDriver {
  readonly type = 'github' as const;
  readonly acceptsWebhooks = true;
  readonly hasInstallations = true;
  readonly key = 'gh';
  readonly checks: { sha: string; conclusion: string }[] = [];
  // What the forge answers when asked for a root config; null means it cannot tell
  rootConfig: boolean | null = null;
  fetches = 0;

  constructor(private readonly originDir: string) {}

  async hasRootConfig(): Promise<boolean | null> {
    return this.rootConfig;
  }

  async remoteHead(repo: RemoteRepo): Promise<string> {
    this.fetches += 1;
    const head = await resolveRemoteHead(
      { authenticatedUrl: `file://${this.originDir}` },
      repo.defaultBranch,
    );
    return head.sha;
  }

  async checkout(
    _repo: RemoteRepo,
    sha: string,
    targetDir: string,
    select: (tree: CommitTree) => Promise<void>,
  ): Promise<CheckedOutCommit> {
    return checkoutCommit({ authenticatedUrl: `file://${this.originDir}` }, sha, targetDir, select);
  }

  async reportCheck(
    _repo: RemoteRepo,
    sha: string,
    result: { conclusion: 'success' | 'failure'; title: string; summary: string },
  ): Promise<void> {
    this.checks.push({ sha, conclusion: result.conclusion });
  }

  verifyWebhook(): WebhookVerification {
    throw new Error('not on the sync path');
  }
  mapEvent(): ForgeAction[] {
    throw new Error('not on the sync path');
  }
  async listInstallations(): Promise<RemoteInstallation[]> {
    throw new Error('not on the sync path');
  }
  async listRepos(): Promise<RemoteRepo[]> {
    throw new Error('not on the sync path');
  }
  async getRepo(): Promise<RemoteRepo | null> {
    throw new Error('not on the sync path');
  }
}

class LocalRegistry extends ForgeRegistry {
  constructor(
    config: ConfigService,
    private readonly local: ForgeDriver,
    private readonly remote: RemoteRepo,
  ) {
    super(config);
  }
  async driverForRepo(): Promise<ForgeDriver | null> {
    return this.local;
  }
  async remoteRepoFor(): Promise<RemoteRepo | null> {
    return this.remote;
  }
}

interface Fixture {
  sync: SyncService;
  driver: LocalOriginDriver;
  repoId: string;
  originDir: string;
}

const temporary: string[] = [];

async function buildFixture(options: {
  forgeRepoId: string;
  slug: string;
  branch: string;
  remoteBranch?: string;
  rowBranch?: string;
  files: Record<string, string>;
}): Promise<Fixture> {
  const sequelize = getSequelize();
  const originDir = createOrigin(options.branch, options.files);
  temporary.push(originDir);

  const config = new ConfigService(
    loadInstanceConfigFromFile(process.env.SPEICHER_CONFIG as string),
  );
  const blobRoot = mkdtempSync(join(tmpdir(), 'speicher-blobs-'));
  temporary.push(blobRoot);
  process.env.SPEICHER_ASSET_PATH = blobRoot;

  const forge =
    (await Forge.findOne({ where: { key: 'gh' } })) ??
    (await Forge.create({
      tenant_id: await defaultTenantId(),
      key: 'gh',
      type: 'github',
      is_primary: true,
      default_repository_owner: 'copetence',
      config: {},
    }));

  const repo = await Repo.create({
    tenant_id: await defaultTenantId(),
    forge_id: forge.id,
    forge_repo_id: options.forgeRepoId,
    namespace: 'copetence',
    namespace_id: '9001',
    slug: options.slug,
    branch: options.rowBranch ?? options.branch,
  });

  const driver = new LocalOriginDriver(originDir);
  const registry = new LocalRegistry(config, driver, {
    forgeRepoId: options.forgeRepoId,
    namespace: 'copetence',
    namespaceId: '9001',
    name: options.slug,
    defaultBranch: options.remoteBranch ?? options.branch,
    private: true,
    archived: false,
  });

  const ingest = new IngestService(config, new FilesystemBlobStore(blobRoot), sequelize);
  const sync = new SyncService(
    registry,
    ingest,
    new RoutingService(config, sequelize),
    new NotifyService(config, new Mailer(config)),
  );

  return { sync, driver, repoId: repo.id, originDir };
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
  await migrateUp(sequelize);
  await truncateAll();
});

afterAll(async () => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
  await closeSequelize();
});

describe('sync from a git repository', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await buildFixture({
      forgeRepoId: '90001',
      slug: 'guide',
      branch: 'main',
      files: {
        '.speicher.yaml': REPO_CONFIG,
        'docs/index.md': '# Guide\n\nThe landing page.\n',
        'docs/01-install.md': '# Install\n\nHow to install it.\n',
      },
    });
  });

  it('checks out the commit and ingests what git actually holds', async () => {
    const result = await fixture.sync.syncRepo(fixture.repoId, 'manual');

    expect(result?.status).toBe('ok');
    expect(await slugsOf(fixture.repoId)).toEqual(['', 'install']);

    const repo = await Repo.findByPk(fixture.repoId);
    expect(repo!.last_sha).toBe(git(['rev-parse', 'HEAD'], fixture.originDir));
    expect(repo!.last_status).toBe('ok');
  });

  it('applies the repo config from the commit, so access is not a fixture artefact', async () => {
    const rows = await getSequelize().query<{ effective_principals: string[] }>(
      `SELECT effective_principals FROM documents WHERE repo_id = :repoId AND slug_path = ''`,
      { type: QueryTypes.SELECT, replacements: { repoId: fixture.repoId } },
    );
    expect(rows[0].effective_principals).toEqual(['group:engineering']);
  });

  it('does no work when head has not moved', async () => {
    const before = await Repo.findByPk(fixture.repoId);
    const result = await fixture.sync.syncRepo(fixture.repoId, 'reconciler');

    expect(result).toBeNull();

    const after = await Repo.findByPk(fixture.repoId);
    expect(after!.last_sha).toBe(before!.last_sha);
    expect(after!.last_run_at!.getTime()).toBeGreaterThanOrEqual(before!.last_run_at!.getTime());
  });

  it('fetches the new head, and a deleted file stops being a page', async () => {
    const sha = commit(
      fixture.originDir,
      'add a page, remove another',
      { 'docs/02-usage.md': '# Usage\n\nHow to use it.\n' },
      ['docs/01-install.md'],
    );

    const result = await fixture.sync.syncRepo(fixture.repoId, 'webhook');

    expect(result?.status).toBe('ok');
    expect(await slugsOf(fixture.repoId)).toEqual(['', 'usage']);
    expect((await Repo.findByPk(fixture.repoId))!.last_sha).toBe(sha);
  });

  it('reports a check run per sync, against the SHA that was ingested', async () => {
    expect(fixture.driver.checks.map((c) => c.conclusion)).toEqual(['success', 'success']);
    expect(fixture.driver.checks.at(-1)!.sha).toBe(git(['rev-parse', 'HEAD'], fixture.originDir));
  });
});

describe('the branch the forge reports', () => {
  it('wins over the branch on the row, so a renamed default branch self-heals', async () => {
    const fixture = await buildFixture({
      forgeRepoId: '90002',
      slug: 'moved',
      branch: 'trunk',
      rowBranch: 'main',
      remoteBranch: 'trunk',
      files: {
        '.speicher.yaml': REPO_CONFIG,
        'docs/index.md': '# Moved\n\nOn a differently named branch.\n',
      },
    });

    const result = await fixture.sync.syncRepo(fixture.repoId, 'reconciler');

    expect(result?.status).toBe('ok');
    expect((await Repo.findByPk(fixture.repoId))!.branch).toBe('trunk');
    expect(await slugsOf(fixture.repoId)).toEqual(['']);
  });
});

describe('a repo the forge reports without a root config', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await buildFixture({
      forgeRepoId: '90003',
      slug: 'unrelated',
      branch: 'main',
      files: { 'README.md': '# Not documentation\n' },
    });
    fixture.driver.rootConfig = false;
  });

  it('is marked unpublished without being fetched or sent a check run', async () => {
    const result = await fixture.sync.syncRepo(fixture.repoId, 'reconciler');

    expect(result).toBeNull();
    expect(fixture.driver.fetches).toBe(0);
    expect(fixture.driver.checks).toEqual([]);
    const repo = await Repo.findByPk(fixture.repoId);
    expect(repo!.has_config).toBe(false);
    expect(repo!.last_run_at).not.toBeNull();
    expect(repo!.last_status).toBe('ok');
  });

  it('is fetched and synced once the forge reports a config', async () => {
    commit(fixture.originDir, 'publish it', {
      '.speicher.yaml': REPO_CONFIG,
      'docs/index.md': '# Now published\n',
    });
    fixture.driver.rootConfig = true;

    const result = await fixture.sync.syncRepo(fixture.repoId, 'webhook');

    expect(result?.status).toBe('ok');
    expect(fixture.driver.fetches).toBe(1);
    expect((await Repo.findByPk(fixture.repoId))!.has_config).toBe(true);
    expect(await slugsOf(fixture.repoId)).toEqual(['']);
  });

  it('is not asked again while it has a config, so a publishing repo costs no extra call', async () => {
    fixture.driver.rootConfig = false;
    commit(fixture.originDir, 'another page', { 'docs/02-more.md': '# More\n' });

    const result = await fixture.sync.syncRepo(fixture.repoId, 'webhook');

    expect(result?.status).toBe('ok');
    expect(fixture.driver.fetches).toBe(2);
  });
});

describe('a repo with nothing to publish', () => {
  const clones = () => readdirSync(CLONE_ROOT).filter((name) => name.includes('-clone-'));

  it('is recorded as unpublished when it has no commits, and keeps no git data', async () => {
    const fixture = await buildFixture({
      forgeRepoId: '90004',
      slug: 'never-pushed',
      branch: 'main',
      files: {},
    });

    const result = await fixture.sync.syncRepo(fixture.repoId, 'reconciler');

    expect(result).toBeNull();
    expect(fixture.driver.fetches).toBe(1);
    const repo = await Repo.findByPk(fixture.repoId);
    expect(repo!.has_config).toBe(false);
    expect(repo!.last_run_at).not.toBeNull();
    expect(repo!.last_status).toBe('ok');
    expect(clones()).toEqual([]);
  });

  it('keeps no git data once the walk finds no root config', async () => {
    const fixture = await buildFixture({
      forgeRepoId: '90005',
      slug: 'no-config',
      branch: 'main',
      files: { 'README.md': '# Not documentation\n' },
    });

    const result = await fixture.sync.syncRepo(fixture.repoId, 'reconciler');

    expect(result?.unpublished).toBe(true);
    expect(fixture.driver.fetches).toBe(1);
    expect(clones()).toEqual([]);
  });
});

describe('a repo whose include leaves out what a page links to', () => {
  it('publishes the included image and reports the left out file as a broken link', async () => {
    const fixture = await buildFixture({
      forgeRepoId: '90006',
      slug: 'linked',
      branch: 'main',
      files: {
        '.speicher.yaml': `${REPO_CONFIG}sync:\n  include: ['**/*.md', '**/*.png']\n`,
        'docs/index.md': '# Linked\n\n![Diagram](diagram.png)\n\n![Scan](scan.bmp)\n',
        'docs/diagram.png': 'png',
        'docs/scan.bmp': 'bmp',
      },
    });

    const result = await fixture.sync.syncRepo(fixture.repoId, 'manual');

    expect(result?.status).toBe('ok');
    expect(result?.stats.assets).toBe(1);
    expect(result?.findings.filter((f) => f.code === 'broken-link').map((f) => f.message)).toEqual([
      'broken internal link "docs/scan.bmp"',
    ]);
  });
});
