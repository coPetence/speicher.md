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
import {
  ForgeAction,
  ForgeDriver,
  RemoteInstallation,
  RemoteRepo,
  WebhookVerification,
} from '../../src/forge/driver';
import { checkoutTree, ensureMirror, resolveHead } from '../../src/forge/git';
import { ForgeRegistry } from '../../src/forge/registry';
import { IngestService } from '../../src/ingest/ingest.service';
import { MIRROR_ROOT, SyncService } from '../../src/jobs/sync.service';
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

  constructor(private readonly originDir: string) {}

  async fetchInto(repo: RemoteRepo, mirrorDir: string): Promise<string> {
    await ensureMirror(mirrorDir, { authenticatedUrl: `file://${this.originDir}` });
    return resolveHead(mirrorDir, repo.defaultBranch);
  }

  async checkout(mirrorDir: string, sha: string, targetDir: string): Promise<void> {
    await checkoutTree(mirrorDir, sha, targetDir);
  }

  async resolveHead(mirrorDir: string, branch: string): Promise<string> {
    return resolveHead(mirrorDir, branch);
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

  it('clones a mirror, materialises the tree, and ingests what git actually holds', async () => {
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

describe('the materialised tree', () => {
  it('carries no .git, so the walk cannot read repository internals', async () => {
    const originDir = createOrigin('main', {
      '.speicher.yaml': REPO_CONFIG,
      'docs/index.md': '# Guide\n',
    });
    temporary.push(originDir);
    const mirrorDir = join(MIRROR_ROOT, 'gh', 'archive-check.git');
    const target = mkdtempSync(join(tmpdir(), 'speicher-tree-'));
    temporary.push(target);

    await ensureMirror(mirrorDir, { authenticatedUrl: `file://${originDir}` });
    await checkoutTree(mirrorDir, await resolveHead(mirrorDir, 'main'), target);

    expect(readdirSync(target).sort()).toEqual(['.speicher.yaml', 'docs']);
  });
});

describe('a failing fetch', () => {
  it('never puts the token in the error, which reaches /-/status and the admin log', async () => {
    const mirrorDir = join(MIRROR_ROOT, 'gh', 'unreachable.git');
    const url = 'https://x-access-token:ghs_supersecrettoken@127.0.0.1:1/copetence/guide.git';

    const error = await ensureMirror(mirrorDir, { authenticatedUrl: url }).catch(
      (err: Error) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('ghs_supersecrettoken');
    expect((error as Error).message).toContain('***');
  });
});
