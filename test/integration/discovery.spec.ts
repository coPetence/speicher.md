import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import request from 'supertest';

import { FilesystemBlobStore } from '../../src/assets/blob-store';
import { ConfigService } from '../../src/config/config.service';
import { validateForSave } from '../../src/config/loader';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import { migrateUp } from '../../src/db/migrate';
import { Forge, Installation, Repo, initModels } from '../../src/db/models';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { ForgeDriver, RemoteRepo } from '../../src/forge/driver';
import { GitOptions } from '../../src/forge/git';
import { GithubDriver } from '../../src/forge/github/github.driver';
import { ForgeRegistry } from '../../src/forge/registry';
import { DELIVERY_DEDUPE_WINDOW_MS } from '../../src/forge/webhook.controller';
import { IngestService } from '../../src/ingest/ingest.service';
import { isConfigFilename } from '../../src/ingest/paths';
import { JobQueue } from '../../src/jobs/queue';
import { RegistrationService } from '../../src/jobs/registration.service';
import { SyncService } from '../../src/jobs/sync.service';
import { Worker } from '../../src/jobs/worker';
import { Mailer } from '../../src/notify/mailer';
import { NotifyService } from '../../src/notify/notify.service';
import { RoutingService } from '../../src/content-reader/routing';
import { defaultTenantId, truncateAll } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

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

function createOrigin(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'speicher-origin-'));
  git(['init', '--quiet', '--initial-branch=main'], dir);
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  git(['add', '-A'], dir);
  git(['commit', '--quiet', '-m', 'initial'], dir);
  return dir;
}

const ACCOUNT = { login: 'coPetence', id: 9001, type: 'Organization' };
const PERSON = { login: 'ferdi', id: 6262, type: 'User' };
const INSTALLATION_ID = 5150;
const PERSONAL_INSTALLATION_ID = 8181;
const REPO_ID = 777_777;
const PERSONAL_REPO_ID = 888_888;

function githubApi(state: { installations: number; repositories: number }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const path = new URL(url).pathname + new URL(url).search;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (path.startsWith('/app/installations?')) {
      state.installations += 1;
      return json([
        { id: INSTALLATION_ID, account: ACCOUNT, suspended_at: null },
        {
          id: 7171,
          account: { login: 'northwind-engineering', id: 5151, type: 'Organization' },
          suspended_at: '2026-08-01T00:00:00Z',
        },
        { id: 8181, account: PERSON, suspended_at: null },
      ]);
    }
    if (init?.method === 'POST' && path.includes('/access_tokens')) {
      const installationId = path.split('/').at(-2) ?? '';
      return json({
        token: `ghs_${installationId}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (path.startsWith('/installation/repositories')) {
      state.repositories += 1;
      const bearer = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
      if (bearer === `Bearer ghs_${PERSONAL_INSTALLATION_ID}`) {
        return json({
          repositories: [
            {
              id: PERSONAL_REPO_ID,
              name: 'notebook',
              default_branch: 'main',
              private: true,
              archived: false,
              owner: PERSON,
            },
          ],
        });
      }
      return json({
        repositories: [
          {
            id: REPO_ID,
            name: 'discovered',
            default_branch: 'main',
            private: true,
            archived: false,
            owner: ACCOUNT,
          },
        ],
      });
    }
    if (path.startsWith(`/repositories/${REPO_ID}`)) {
      return json({
        id: REPO_ID,
        name: 'discovered',
        default_branch: 'main',
        private: true,
        archived: false,
        owner: ACCOUNT,
      });
    }
    if (path.startsWith(`/repositories/${PERSONAL_REPO_ID}`)) {
      return json({
        id: PERSONAL_REPO_ID,
        name: 'notebook',
        default_branch: 'main',
        private: true,
        archived: false,
        owner: PERSON,
      });
    }
    return new Response('', { status: 404, statusText: 'Not Found' });
  }) as typeof fetch;
}

class OriginBackedGithubDriver extends GithubDriver {
  constructor(
    key: string,
    config: ConstructorParameters<typeof GithubDriver>[1],
    fetchImpl: typeof fetch,
    private readonly originDir: string,
  ) {
    super(key, config, () => undefined, fetchImpl);
  }

  protected override async withRemote<T>(
    _repo: RemoteRepo,
    run: (remote: GitOptions) => Promise<T>,
  ): Promise<T> {
    return run({ authenticatedUrl: `file://${this.originDir}` });
  }

  // The fake API has no contents endpoint, so the origin's files answer instead
  override async hasRootConfig(): Promise<boolean> {
    return readdirSync(this.originDir).some(isConfigFilename);
  }
}

class OneDriverRegistry extends ForgeRegistry {
  constructor(
    config: ConfigService,
    private readonly only: ForgeDriver,
  ) {
    super(config);
  }
  override driver(): ForgeDriver | null {
    return this.only;
  }
}

const temporary: string[] = [];
let config: ConfigService;
let tenantId: string;
let forgeId: string;
let registration: RegistrationService;
let sync: SyncService;
let apiCalls: { installations: number; repositories: number };

beforeAll(async () => {
  const sequelize = getSequelize();
  initModels(sequelize);
  await migrateUp(sequelize);
  await truncateAll();

  config = new ConfigService(loadInstanceConfigFromFile(process.env.SPEICHER_CONFIG as string));
  tenantId = await defaultTenantId();

  const forge = await Forge.create({
    tenant_id: tenantId,
    key: 'gh',
    type: 'github',
    is_primary: true,
    default_repository_owner: 'copetence',
    config: {},
  });
  forgeId = forge.id;

  const originDir = createOrigin({
    '.speicher.yaml': 'version: 1\naccess:\n  groups: [engineering]\n',
    'index.md': '# Discovered\n\nA page nobody was told about.\n',
    'guide.md': '# Guide\n\nAnd a second one, so the assertion names a path.\n',
  });
  const blobRoot = mkdtempSync(join(tmpdir(), 'speicher-blobs-'));
  temporary.push(originDir, blobRoot);
  process.env.SPEICHER_ASSET_PATH = blobRoot;

  apiCalls = { installations: 0, repositories: 0 };
  const driver = new OriginBackedGithubDriver(
    'gh',
    config.forge('gh') as ConstructorParameters<typeof GithubDriver>[1],
    githubApi(apiCalls),
    originDir,
  );
  const registry = new OneDriverRegistry(config, driver);
  const routing = new RoutingService(config, sequelize);

  registration = new RegistrationService(config, registry, routing);
  sync = new SyncService(
    registry,
    new IngestService(config, new FilesystemBlobStore(blobRoot), sequelize),
    routing,
    new NotifyService(config, new Mailer(config)),
  );
});

afterAll(async () => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
  await closeSequelize();
});

describe('an instance that is never sent a webhook', () => {
  it('reaches served content by asking the forge what it holds', async () => {
    await registration.syncInstallationAndRepoRows(tenantId, 'gh');

    const repo = await Repo.findOne({
      where: { tenant_id: tenantId, forge_id: forgeId, forge_repo_id: String(REPO_ID) },
    });
    expect(repo).not.toBeNull();
    expect(repo?.installation_id).not.toBeNull();

    const result = await sync.syncRepo(repo!.id, 'manual');
    expect(result).not.toBeNull();

    const pages = await getSequelize().query<{ slug_path: string }>(
      `SELECT slug_path FROM documents WHERE repo_id = :repoId`,
      { type: QueryTypes.SELECT, replacements: { repoId: repo!.id } },
    );
    expect(pages.map((page) => page.slug_path).sort()).toEqual(['', 'guide']);

    const deliveries = await getSequelize().query<{ count: string }>(
      `SELECT count(*) AS count FROM webhook_deliveries`,
      { type: QueryTypes.SELECT },
    );
    expect(Number(deliveries[0].count)).toBe(0);
  });

  it('writes the installation row from the listing that named it', async () => {
    const installation = await Installation.findOne({
      where: {
        tenant_id: tenantId,
        forge_id: forgeId,
        forge_installation_id: String(INSTALLATION_ID),
      },
    });
    expect(installation?.namespace).toBe('coPetence');
    expect(installation?.namespace_id).toBe(String(ACCOUNT.id));
    expect(installation?.account_type).toBe('Organization');
    expect(installation?.suspended_at).toBeNull();
  });

  it('keeps the owner as the forge spells it', async () => {
    const repo = await Repo.findOne({ where: { forge_repo_id: String(REPO_ID) } });
    expect(repo?.namespace).toBe('coPetence');
    expect(repo?.slug).toBe('discovered');
  });

  it('serves a repository under a person’s own account, which it refused outright before', async () => {
    const installation = await Installation.findOne({
      where: {
        tenant_id: tenantId,
        forge_id: forgeId,
        forge_installation_id: String(PERSONAL_INSTALLATION_ID),
      },
    });
    expect(installation?.account_type).toBe('User');

    const repo = await Repo.findOne({
      where: { tenant_id: tenantId, forge_repo_id: String(PERSONAL_REPO_ID) },
    });
    expect(repo?.namespace).toBe('ferdi');
    expect(repo?.installation_id).not.toBeNull();
  });

  it('records a suspended installation and never asks it for repositories', async () => {
    const suspended = await Installation.findOne({
      where: { tenant_id: tenantId, forge_id: forgeId, forge_installation_id: '7171' },
    });
    expect(suspended?.suspended_at).not.toBeNull();
    expect(await Repo.count({ where: { namespace: 'northwind-engineering' } })).toBe(0);
  });

  it('is idempotent: a second discovery writes no second row', async () => {
    const before = apiCalls.installations;
    await registration.syncInstallationAndRepoRows(tenantId, 'gh');
    expect(apiCalls.installations).toBe(before + 1);

    const repos = await Repo.count({ where: { tenant_id: tenantId } });
    const installations = await Installation.count({ where: { tenant_id: tenantId } });
    expect(repos).toBe(2);
    expect(installations).toBe(3);
  });
});

describe('dead jobs', () => {
  it('are claimable again once they are retried', async () => {
    const queue = new JobQueue();
    await queue.enqueue({
      tenantId,
      kind: 'sync-repo-list',
      payload: { forgeKey: 'gh' },
      dedupeKey: 'sync-repo-list:retry-fixture',
      maxAttempts: 1,
    });

    const [claimed] = await queue.claim(1);
    expect(claimed).toBeDefined();
    await queue.fail(claimed, 'error:1E08010C:DECODER routines::unsupported');

    expect(await queue.claim(1)).toEqual([]);

    expect(await queue.retryDead({ tenantId, ids: [claimed.id] })).toBe(1);
    const [again] = await queue.claim(1);
    expect(again?.id).toBe(claimed.id);
    expect(again.attempts).toBe(1);
    await queue.complete(again.id);
  });

  it('are not confused with a running job by a mistyped id', async () => {
    await expect(new JobQueue().retryDead({ tenantId, ids: ['not-a-uuid'] })).resolves.toBe(0);
  });
});

describe('a private key the crypto library cannot read', () => {
  const withKey = (key: string) => `version: 1
auth:
  providers:
    entra:
      type: oidc
      issuer: https://login.microsoftonline.com/tenant/v2.0
      client_id: id
      client_secret: secret
admins:
  users:
    - provider: entra
      subject: someone
      note: the administrator
forges:
  gh:
    type: github
    primary: true
    app_id: '1'
    private_key: ${JSON.stringify(key)}
    webhook_secret: hook
`;

  it('is refused at save, naming line breaks', () => {
    const oneLine = (process.env.TEST_GH_PRIVATE_KEY as string).replace(/\r?\n/g, '');
    expect(() => validateForSave(withKey(oneLine))).toRefuseWith('github.private-key-unreadable');
    try {
      validateForSave(withKey(oneLine));
    } catch (err) {
      expect((err as { problems: string[] }).problems.join('\n')).toMatch(/line breaks/);
      expect((err as { problems: string[] }).problems.join('\n')).toContain(
        'forges.gh.private_key',
      );
    }
  });

  it('accepts the same key with its line breaks intact', () => {
    expect(() => validateForSave(withKey(process.env.TEST_GH_PRIVATE_KEY as string))).not.toThrow();
  });
});

describe('a redelivery an operator asked for', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await bootTestApp();
    admin = await sessionCookieFor(tenantId, 'ops');
  });

  afterAll(async () => {
    await app?.close();
  });

  async function deliver(deliveryId: string): Promise<number> {
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      after: 'a'.repeat(40),
      repository: { id: 424_242, default_branch: 'main' },
    });
    const signature = `sha256=${createHmac('sha256', process.env.TEST_GH_WEBHOOK_SECRET as string)
      .update(Buffer.from(body, 'utf8'))
      .digest('hex')}`;

    const response = await request(app.getHttpServer())
      .post('/-/hooks/forge/gh')
      .set('content-type', 'application/json')
      .set('x-github-event', 'push')
      .set('x-github-delivery', deliveryId)
      .set('x-hub-signature-256', signature)
      .send(body);
    return response.status;
  }

  async function discoverJobs(): Promise<number> {
    const [row] = await getSequelize().query<{ count: string }>(
      `SELECT count(*) AS count FROM jobs
        WHERE tenant_id = :tenantId AND kind = 'sync-repo-list' AND dedupe_key = 'sync-repo-list:gh'`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
    return Number(row.count);
  }

  async function clearDiscoverJobs(): Promise<void> {
    await getSequelize().query(`DELETE FROM jobs WHERE kind = 'sync-repo-list'`, {
      type: QueryTypes.DELETE,
    });
  }

  it('enqueues discovery when the delivery names a repository nothing registered', async () => {
    await clearDiscoverJobs();
    expect(await deliver('delivery-one')).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await discoverJobs()).toBe(1);
  });

  it('is a duplicate inside the window', async () => {
    await clearDiscoverJobs();
    expect(await deliver('delivery-one')).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await discoverJobs()).toBe(0);
  });

  it('is processed outside it', async () => {
    await clearDiscoverJobs();
    await getSequelize().query(
      `UPDATE webhook_deliveries
          SET received_at = now() - make_interval(secs => :seconds)
        WHERE delivery_id = 'delivery-one'`,
      {
        type: QueryTypes.UPDATE,
        replacements: { seconds: DELIVERY_DEDUPE_WINDOW_MS / 1000 + 60 },
      },
    );

    expect(await deliver('delivery-one')).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await discoverJobs()).toBe(1);
  });

  it('is what the dashboard offers without any of this, and syncs every repository with it', async () => {
    await clearDiscoverJobs();
    await getSequelize().query(`DELETE FROM jobs WHERE kind = 'sync-repo-content'`, {
      type: QueryTypes.DELETE,
    });
    const [{ count: repos }] = await getSequelize().query<{ count: string }>(
      `SELECT count(*) AS count FROM repos r JOIN forges f ON f.id = r.forge_id
        WHERE r.tenant_id = :tenantId AND f.key = 'gh'`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
    expect(Number(repos)).toBeGreaterThan(0);

    await request(app.getHttpServer())
      .post('/-/discover')
      .set('cookie', admin)
      .set('accept', 'application/json')
      .expect(200, { discovering: ['gh'], syncing: Number(repos) });
    expect(await discoverJobs()).toBe(1);

    // An ordinary sync each, which skips a repository whose commit has not changed
    const syncs = await getSequelize().query<{ trigger: string }>(
      `SELECT payload->>'trigger' AS trigger FROM jobs
        WHERE tenant_id = :tenantId AND kind = 'sync-repo-content'`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
    expect(syncs).toHaveLength(Number(repos));
    expect(syncs.every((job) => job.trigger === 'manual')).toBe(true);
  });

  it('is what the reconciler asks for on its own, without anybody pressing anything', async () => {
    await clearDiscoverJobs();
    const worker = app.get(Worker);
    const tick = async (): Promise<number> => {
      (worker as unknown as { running: boolean }).running = true;
      try {
        await worker.reconcile();
      } finally {
        (worker as unknown as { running: boolean }).running = false;
      }

      const [row] = await getSequelize().query<{ run_after: Date }>(
        `SELECT run_after FROM jobs
          WHERE tenant_id = :tenantId AND kind = 'sync-repo-list' AND dedupe_key = 'sync-repo-list:gh'`,
        { type: QueryTypes.SELECT, replacements: { tenantId } },
      );
      expect(row).toBeDefined();
      return new Date(row.run_after).getTime();
    };

    expect(await tick()).toBeLessThan(Date.now() + 60_000);

    await clearDiscoverJobs();
    expect(await tick()).toBeGreaterThan(Date.now() + 60_000);
  });

  it('syncs one repository on demand, from the page that shows it', async () => {
    await getSequelize().query(`DELETE FROM jobs WHERE kind = 'sync-repo-content'`, {
      type: QueryTypes.DELETE,
    });
    await request(app.getHttpServer())
      .post('/-/sync')
      .set('cookie', admin)
      .set('accept', 'application/json')
      .send({ namespace: 'coPetence', slug: 'discovered' })
      .expect(200, { syncing: 'coPetence/discovered' });

    const [row] = await getSequelize().query<{ count: string }>(
      `SELECT count(*) AS count FROM jobs WHERE kind = 'sync-repo-content'`,
      { type: QueryTypes.SELECT },
    );
    expect(Number(row.count)).toBe(1);
  });

  it('queues only the discovery of one source when it names that source', async () => {
    await clearDiscoverJobs();

    await request(app.getHttpServer())
      .post('/-/discover')
      .set('cookie', admin)
      .set('accept', 'application/json')
      .type('form')
      .send({ source: 'gh' })
      .expect(200, { discovering: ['gh'], syncing: 0 });
    expect(await discoverJobs()).toBe(1);

    await request(app.getHttpServer())
      .post('/-/discover')
      .set('cookie', admin)
      .type('form')
      .send({ source: 'nowhere' })
      .expect(404);
  });

  it('leads back to the repositories page when it was started there', async () => {
    const discovered = await request(app.getHttpServer())
      .post('/-/discover')
      .set('cookie', admin)
      .type('form')
      .send({ back: 'repositories' })
      .expect(303);
    expect(discovered.headers.location).toBe('/-/repositories');

    const synced = await request(app.getHttpServer())
      .post('/-/sync')
      .set('cookie', admin)
      .type('form')
      .send({ namespace: 'coPetence', slug: 'discovered', back: 'repositories' })
      .expect(303);
    expect(synced.headers.location).toBe('/-/repositories');
  });

  it('answers the reader 404 for a repository that is not there', async () => {
    await request(app.getHttpServer())
      .post('/-/sync')
      .set('cookie', admin)
      .send({ namespace: 'coPetence', slug: 'no-such-thing' })
      .expect(404);
  });

  it('is not offered to anybody but an administrator', async () => {
    await request(app.getHttpServer()).post('/-/discover').expect(404);
    await request(app.getHttpServer()).post('/-/jobs/retry').expect(404);
    await request(app.getHttpServer()).post('/-/sync').expect(404);
  });
});
