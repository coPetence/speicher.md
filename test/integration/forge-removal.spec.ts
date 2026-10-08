import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { parseDocument } from 'yaml';

import { ConfigService } from '../../src/config/config.service';
import { LoadedInstanceConfig, loadInstanceConfig } from '../../src/config/parser';
import { unclaimedInstanceConfig } from '../../src/dashboard/setup/unclaimed';
import { Forge, Repo } from '../../src/db/models';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { ForgeRegistry } from '../../src/forge/registry';
import { JobQueue } from '../../src/jobs/queue';
import { Worker } from '../../src/jobs/worker';
import { FIXTURE_ROOT, FIXTURE_SHA, Harness, createHarness } from '../helpers/harness';
import { bootTestApp } from '../helpers/http';

// A forge that leaves the configuration takes its repositories, their pages and
// their blobs with it. The blobs are the half no cascade reaches: the store files
// them by repo id, so a forge row deleted first would strand them for good.
let harness: Harness;
let app: INestApplication;
let queue: JobQueue;
let worker: Worker;

async function count(sql: string, replacements: Record<string, unknown>): Promise<number> {
  const [row] = await getSequelize().query<{ count: string }>(sql, {
    type: QueryTypes.SELECT,
    replacements,
  });
  return Number(row.count);
}

async function reconcileOnce(): Promise<void> {
  (worker as unknown as { running: boolean }).running = true;
  try {
    await worker.reconcile();
  } finally {
    (worker as unknown as { running: boolean }).running = false;
  }
}

async function reconcileAndRunPurges(): Promise<void> {
  await reconcileOnce();
  const jobs = (await queue.claim(50)).filter((job) => job.kind === 'purge-forge');
  for (const job of jobs) {
    await (worker as unknown as { run(row: typeof job): Promise<void> }).run(job);
  }
}

beforeAll(async () => {
  harness = await createHarness();
  app = await bootTestApp();
  queue = app.get(JobQueue);
  worker = app.get(Worker);
});

afterAll(async () => {
  await app.close();
  await harness.close();
  await closeSequelize();
});

beforeEach(async () => {
  await getSequelize().query('DELETE FROM jobs', { type: QueryTypes.DELETE });
});

describe('a forge removed from the configuration', () => {
  it('loses its repositories, their pages and their blobs', async () => {
    const forge = await Forge.create({
      tenant_id: harness.tenantId,
      key: 'retired',
      type: 'github',
      is_primary: false,
      default_repository_owner: null,
      config: {},
    });
    const repo = await Repo.create({
      tenant_id: harness.tenantId,
      forge_id: forge.id,
      forge_repo_id: '8001',
      namespace: 'copetence',
      namespace_id: '9001',
      slug: 'retired-handbook',
      branch: 'main',
    });
    const result = await harness.ingest.syncRepo(repo.id, {
      workingTree: join(FIXTURE_ROOT, 'repos', 'handbook'),
      sha: FIXTURE_SHA,
      trigger: 'manual',
    });
    expect(result.status).toBe('ok');

    const hashes = (
      await getSequelize().query<{ content_hash: string }>(
        'SELECT content_hash FROM assets WHERE repo_id = :repoId',
        { type: QueryTypes.SELECT, replacements: { repoId: repo.id } },
      )
    ).map((row) => row.content_hash);
    // Without a stored blob the assertion below would pass by having nothing to lose
    expect(hashes.length).toBeGreaterThan(0);
    for (const hash of hashes) expect(await harness.blobs.exists(repo.id, hash)).toBe(true);

    // Work queued for the forge before it left: due later, so the claim below skips it
    const later = 6 * 60 * 60 * 1000;
    await queue.enqueue({
      tenantId: harness.tenantId,
      kind: 'sync-repo-list',
      payload: { forgeKey: 'retired' },
      dedupeKey: 'sync-repo-list:retired',
      runAfterMs: later,
    });
    await queue.enqueue({
      tenantId: harness.tenantId,
      kind: 'sync-repo-content',
      payload: { repoId: repo.id },
      dedupeKey: `sync-repo-content:${repo.id}`,
      runAfterMs: later,
    });

    await reconcileAndRunPurges();

    expect(await Forge.findByPk(forge.id)).toBeNull();
    expect(await Repo.findByPk(repo.id)).toBeNull();
    expect(
      await count('SELECT count(*) FROM documents WHERE repo_id = :repoId', { repoId: repo.id }),
    ).toBe(0);
    for (const hash of hashes) expect(await harness.blobs.exists(repo.id, hash)).toBe(false);
    expect(
      await count(
        `SELECT count(*) FROM jobs
          WHERE status = 'pending'
            AND (payload->>'forgeKey' = 'retired' OR payload->>'repoId' = :repoId)`,
        { repoId: repo.id },
      ),
    ).toBe(0);
  });

  it('leaves a configured forge and its content alone', async () => {
    await reconcileAndRunPurges();

    expect(await Forge.findOne({ where: { key: 'gh' } })).not.toBeNull();
    expect(
      await count('SELECT count(*) FROM documents WHERE repo_id = :repoId', {
        repoId: harness.repos.handbook,
      }),
    ).toBeGreaterThan(0);
  });

  it('is not purged when it is configured again before the job runs', async () => {
    const gh = await Forge.findOne({ where: { key: 'gh' } });
    await queue.enqueue({
      tenantId: harness.tenantId,
      kind: 'purge-forge',
      payload: { forgeId: gh!.id, forgeKey: 'gh' },
    });
    const [job] = await queue.claim(1);
    await (worker as unknown as { run(row: typeof job): Promise<void> }).run(job);

    expect(await Forge.findByPk(gh!.id)).not.toBeNull();
    expect(await Repo.findByPk(harness.repos.handbook)).not.toBeNull();
  });

  it('is never found on an unclaimed instance, whose placeholder names no forge', async () => {
    const registry = new ForgeRegistry(new ConfigService(unclaimedInstanceConfig()));
    expect(await registry.findRemovedForgeRows(harness.tenantId)).toEqual([]);
  });
});

describe('the reconciler after a configuration change', () => {
  let original: LoadedInstanceConfig;
  const config = (): ConfigService => app.get(ConfigService);

  function adoptVersion(
    version: number,
    withForges: boolean,
    change?: (doc: ReturnType<typeof parseDocument>) => void,
  ): void {
    const doc = parseDocument(readFileSync(join(FIXTURE_ROOT, 'instance.yaml'), 'utf8'));
    if (!withForges) doc.deleteIn(['forges']);
    change?.(doc);
    config().adopt({ ...loadInstanceConfig(doc.toString()), source: 'database', version });
  }

  beforeAll(() => {
    original = config().loadedConfig;
  });

  afterEach(() => {
    config().adopt(original);
  });

  async function deleteJobs(): Promise<void> {
    await getSequelize().query('DELETE FROM jobs', { type: QueryTypes.DELETE });
  }

  // The reconciler remembers which configuration it last listed a forge for, and an
  // unchanged one waits a discovery interval. A forge removed and added back, with its
  // rows purged in between, has to count as new, or its repositories wait hours.
  it('lists a forge that comes back at once, not a discovery interval later', async () => {
    adoptVersion(2, true);
    await reconcileOnce();
    await deleteJobs();
    adoptVersion(3, false);
    await reconcileOnce();
    await deleteJobs();
    adoptVersion(4, true);
    await reconcileOnce();

    expect(
      await count(
        `SELECT count(*) FROM jobs
          WHERE dedupe_key = 'sync-repo-list:gh' AND run_after <= now() + interval '1 minute'`,
        {},
      ),
    ).toBe(1);
  });

  // Registration writes a row and changes no configuration, so nothing else would
  // notice the new repo before the next reconcile tick
  it('queues the first sync of a repository the listing registers, and only once', async () => {
    adoptVersion(20, true, (doc) =>
      doc.setIn(['forges', 'plain'], {
        type: 'git',
        known_hosts: 'git.example.test ssh-ed25519 AAAA',
        repos: [
          {
            id: 'notes',
            url: 'ssh://git@git.example.test/ops/notes.git',
            deploy_key: '-----BEGIN OPENSSH PRIVATE KEY-----',
            branch: 'main',
          },
        ],
      }),
    );
    const listPlain = async (): Promise<void> => {
      await queue.enqueue({
        tenantId: harness.tenantId,
        kind: 'sync-repo-list',
        payload: { forgeKey: 'plain' },
        dedupeKey: 'sync-repo-list:plain',
      });
      const [job] = (await queue.claim(10)).filter((row) => row.kind === 'sync-repo-list');
      await (worker as unknown as { run(row: typeof job): Promise<void> }).run(job);
    };
    const firstSyncs = (repoId: string): Promise<number> =>
      count(
        `SELECT count(*) FROM jobs
          WHERE dedupe_key = :key AND status = 'pending' AND run_after <= now() + interval '1 minute'`,
        { key: `sync-repo-content:${repoId}` },
      );

    await listPlain();
    const repo = await Repo.findOne({ where: { forge_repo_id: 'notes' } });
    expect(repo).not.toBeNull();
    expect(await firstSyncs(repo!.id)).toBe(1);

    await deleteJobs();
    await listPlain();
    expect(await firstSyncs(repo!.id)).toBe(0);
  });

  it('reconciles on the first tick after an adoption, not at the next reconcile tick', async () => {
    const internals = worker as unknown as {
      running: boolean;
      inFlight: number;
      tick(): Promise<void>;
    };
    const spy = jest.spyOn(worker, 'reconcile');
    internals.running = true;
    // No free slot, so the tick claims nothing and only the configuration check runs
    internals.inFlight = Number.MAX_SAFE_INTEGER;
    try {
      adoptVersion(10, true);
      await internals.tick();
      expect(spy).toHaveBeenCalledTimes(1);
      await spy.mock.results[0].value;

      await internals.tick();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      internals.running = false;
      internals.inFlight = 0;
      spy.mockRestore();
    }
  });
});
