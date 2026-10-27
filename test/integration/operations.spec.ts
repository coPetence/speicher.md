import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';

import { CrawlRepository } from '../../src/authz/content/crawl.repository';
import { runCli } from '../../src/cli/cli';
import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import { closeSequelize, databaseUrl, getSequelize } from '../../src/db/sequelize';
import { JobQueue, advisoryKey } from '../../src/jobs/queue';
import { checkResolutionHash } from '../../src/config/resolution-guard';
import { Worker } from '../../src/jobs/worker';
import { FIXTURE_ROOT, FIXTURE_SHA, Harness, createHarness } from '../helpers/harness';
import { bootTestApp } from '../helpers/http';

let harness: Harness;
let queue: JobQueue;

beforeAll(async () => {
  harness = await createHarness();
  queue = new JobQueue(getSequelize());
});

afterAll(async () => {
  await harness?.close();
  await closeSequelize();
});

describe('job queue', () => {
  it('claims a job and completes it', async () => {
    await queue.enqueue({
      tenantId: harness.tenantId,
      kind: 'sync-repo-content',
      payload: { repoId: 'x' },
    });
    const [job] = await queue.claim(1);
    expect(job.kind).toBe('sync-repo-content');
    expect(job.attempts).toBe(1);
    await queue.complete(job.id);
    expect(await queue.claim(1)).toHaveLength(0);
  });

  it('debounces on the dedupe key rather than adding a row per push', async () => {
    for (let i = 0; i < 5; i++) {
      await queue.enqueue({
        tenantId: harness.tenantId,
        kind: 'sync-repo-content',
        payload: { repoId: 'r1', n: i },
        dedupeKey: 'sync-repo-content:r1',
      });
    }
    const rows = await getSequelize().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs WHERE dedupe_key = 'sync-repo-content:r1' AND status = 'pending'`,
      { type: QueryTypes.SELECT },
    );
    expect(Number(rows[0].count)).toBe(1);
    const [job] = await queue.claim(1);
    expect(job.payload.n).toBe(4);
    await queue.complete(job.id);
  });

  it('retries with backoff, then dead-letters', async () => {
    await queue.enqueue({
      tenantId: harness.tenantId,
      kind: 'sync-repo-content',
      payload: { repoId: 'doomed' },
      maxAttempts: 2,
    });

    const [first] = await queue.claim(1);
    await queue.fail(first, 'boom');
    let row = await jobRow(first.id);
    expect(row.status).toBe('pending');
    expect(await isInTheFuture(row.run_after)).toBe(true);

    await getSequelize().query(`UPDATE jobs SET run_after = now() WHERE id = :id`, {
      type: QueryTypes.UPDATE,
      replacements: { id: first.id },
    });
    const [second] = await queue.claim(1);
    await queue.fail(second, 'boom again');
    row = await jobRow(first.id);
    expect(row.status).toBe('dead');
    expect(row.last_error).toBe('boom again');
  });

  describe('an automatic enqueue', () => {
    afterEach(async () => {
      await getSequelize().query(
        `DELETE FROM jobs WHERE dedupe_key LIKE 'sync-repo-content:auto-%'`,
        { type: QueryTypes.DELETE },
      );
    });

    it('does not revive a key whose newest job is dead, but an explicit one does', async () => {
      await enqueueSync('auto-dead', false);
      await setNewestStatus('auto-dead', 'dead');

      expect(await enqueueSync('auto-dead', true)).toBe(false);
      expect(await statusesOf('auto-dead')).toEqual(['dead']);

      expect(await enqueueSync('auto-dead', false)).toBe(true);
      expect(await statusesOf('auto-dead')).toEqual(['dead', 'pending']);
    });

    it('enqueues the key again once a later job is done', async () => {
      await enqueueSync('auto-recovered', false);
      await setNewestStatus('auto-recovered', 'dead');
      await enqueueSync('auto-recovered', false);
      await setNewestStatus('auto-recovered', 'done');

      expect(await enqueueSync('auto-recovered', true)).toBe(true);
      expect(await statusesOf('auto-recovered')).toEqual(['dead', 'done', 'pending']);
    });

    it('leaves the run time and payload of a pending retry alone', async () => {
      await enqueueSync('auto-retry', false, { n: 1 });
      await getSequelize().query(
        `UPDATE jobs SET attempts = 1, run_after = now() + interval '10 minutes'
          WHERE dedupe_key = 'sync-repo-content:auto-retry'`,
        { type: QueryTypes.UPDATE },
      );

      expect(await enqueueSync('auto-retry', true, { n: 2 })).toBe(false);
      let [job] = await pendingJobsOf('auto-retry');
      expect(await isInTheFuture(job.run_after)).toBe(true);
      expect(job.payload.n).toBe(1);

      expect(await enqueueSync('auto-retry', false, { n: 3 })).toBe(true);
      [job] = await pendingJobsOf('auto-retry');
      expect(await isInTheFuture(job.run_after)).toBe(false);
      expect(job.payload.n).toBe(3);
    });

    it('still debounces a pending job that has not run yet', async () => {
      await queue.enqueue({
        tenantId: harness.tenantId,
        kind: 'sync-repo-content',
        payload: { repoId: 'auto-fresh' },
        dedupeKey: 'sync-repo-content:auto-fresh',
        runAfterMs: 10 * 60 * 1000,
      });

      expect(await enqueueSync('auto-fresh', true)).toBe(true);
      const jobs = await pendingJobsOf('auto-fresh');
      expect(jobs).toHaveLength(1);
      expect(await isInTheFuture(jobs[0].run_after)).toBe(false);
    });
  });

  it('reclaims a job whose worker died, once the visibility timeout passes', async () => {
    await queue.enqueue({ tenantId: harness.tenantId, kind: 'purge', payload: { repoId: 'z' } });
    const [job] = await queue.claim(1);
    expect(await queue.claim(1)).toHaveLength(0);

    await getSequelize().query(
      `UPDATE jobs SET locked_until = now() - interval '1 minute' WHERE id = :id`,
      { type: QueryTypes.UPDATE, replacements: { id: job.id } },
    );
    const [reclaimed] = await queue.claim(1);
    expect(reclaimed.id).toBe(job.id);
    expect(reclaimed.attempts).toBe(2);
    await queue.complete(job.id);
  });

  it('serialises work on one repo across two workers', async () => {
    const repoId = harness.repos.handbook;
    const otherWorker = new JobQueue(
      new Sequelize(databaseUrl(), { dialect: 'postgres', logging: false }),
    );
    let secondRan = false;

    try {
      const held = await queue.withRepoLock(repoId, async () => {
        const contended = await otherWorker.withRepoLock(repoId, async () => {
          secondRan = true;
          return 'second';
        });
        expect(contended).toBeNull();
        return 'first';
      });

      expect(held).toBe('first');
      expect(secondRan).toBe(false);

      await expect(otherWorker.withRepoLock(repoId, async () => 'now-free')).resolves.toBe(
        'now-free',
      );
    } finally {
      await (otherWorker as unknown as { sequelize: Sequelize }).sequelize.close();
    }
  });

  it('releases the lock even when the body throws', async () => {
    const repoId = harness.repos.specs;
    const boom = new Error('boom');
    await expect(
      queue.withRepoLock(repoId, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    await expect(queue.withRepoLock(repoId, async () => 'ok')).resolves.toBe('ok');
  });

  it('derives a stable advisory key from a repo id', () => {
    expect(advisoryKey('abc')).toBe(advisoryKey('abc'));
    expect(advisoryKey('abc')).not.toBe(advisoryKey('abd'));
  });

  it('reports queue depth for metrics', async () => {
    const depth = await queue.depth();
    expect(depth.dead).toBeGreaterThanOrEqual(1);
  });
});

describe('the resolution hash guard', () => {
  it('records the hash on first run without enqueueing a rebuild', async () => {
    await getSequelize().query(`DELETE FROM instance_state`, { type: QueryTypes.DELETE });
    await getSequelize().query(`DELETE FROM jobs WHERE kind = 'rebuild'`, {
      type: QueryTypes.DELETE,
    });

    const result = await checkResolutionHash(harness.config);
    expect(result.previous).toBeNull();
    expect(result.changed).toBe(false);
    expect(await rebuildJobCount()).toBe(0);
  });

  it('is a no-op when nothing resolution-relevant changed', async () => {
    const result = await checkResolutionHash(harness.config);
    expect(result.changed).toBe(false);
    expect(await rebuildJobCount()).toBe(0);
  });

  it('enqueues a full rebuild when the groups map changes', async () => {
    const altered = new ConfigService(
      loadInstanceConfigFromFile(join(FIXTURE_ROOT, 'instance.yaml')),
    );
    Object.defineProperty(altered, 'resolutionHash', {
      get: () => 'a-different-hash',
      configurable: true,
    });

    const result = await checkResolutionHash(altered);
    expect(result.changed).toBe(true);
    expect(await rebuildJobCount()).toBe(1);
  });
});

describe('full rebuild', () => {
  it('reproduces byte-identical rows from the same commit', async () => {
    const crawl = new CrawlRepository(getSequelize());
    const alice = harness.caller('alice');
    const before = await crawl.reachablePaths(alice.principals, harness.tenantId);
    const beforeHashes = await contentHashes();

    await getSequelize().query(`DELETE FROM documents; DELETE FROM folders; DELETE FROM assets;`, {
      type: QueryTypes.DELETE,
    });
    expect((await crawl.reachablePaths(alice.principals, harness.tenantId)).documents).toEqual([]);

    for (const [repoId, dir] of [
      [harness.repos.handbook, 'handbook'],
      [harness.repos.specs, 'specs'],
      [harness.repos.fieldkit, 'fieldkit'],
      [harness.repos.speicherDocs, 'speicher-docs'],
    ] as const) {
      const result = await harness.ingest.syncRepo(repoId, {
        workingTree: join(FIXTURE_ROOT, 'repos', dir),
        sha: FIXTURE_SHA,
        trigger: 'rebuild',
        now: new Date('2026-08-21T12:00:00Z'),
      });
      expect(result.status).toBe('ok');
    }

    expect(await crawl.reachablePaths(alice.principals, harness.tenantId)).toEqual(before);
    expect(await contentHashes()).toEqual(beforeHashes);
  });

  it('does not re-upload an asset whose content hash is unchanged', async () => {
    const result = await harness.ingest.syncRepo(harness.repos.handbook, {
      workingTree: join(FIXTURE_ROOT, 'repos', 'handbook'),
      sha: FIXTURE_SHA,
      trigger: 'rebuild',
      now: new Date('2026-08-21T12:00:00Z'),
    });
    expect(result.stats.assets).toBeGreaterThan(0);
    expect(result.stats.assets_uploaded).toBe(0);
  });
});

describe('speicher rebuild', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await getSequelize().query(`DELETE FROM jobs`, { type: QueryTypes.DELETE });
  });

  // The CLI queues the same `rebuild` job a resolution-hash change does, so what a
  // full rebuild means is decided by the worker alone
  it('queues one rebuild, which the worker turns into a sync per repository', async () => {
    expect(await runCli(['rebuild'])).toBe(0);

    const [rebuild] = (await queue.claim(10)).filter((job) => job.kind === 'rebuild');
    expect(rebuild).toBeDefined();
    await (app.get(Worker) as unknown as { run(row: typeof rebuild): Promise<void> }).run(rebuild);

    const jobs = await getSequelize().query<{ payload: { repoId: string; trigger: string } }>(
      `SELECT payload FROM jobs WHERE kind = 'sync-repo-content' AND status = 'pending'`,
      { type: QueryTypes.SELECT },
    );
    expect(jobs.map((j) => j.payload.repoId).sort()).toEqual(Object.values(harness.repos).sort());
    expect(jobs.every((j) => j.payload.trigger === 'rebuild')).toBe(true);
  });

  it('leaves the rows serving without --purge, and drops them with it', async () => {
    expect(await runCli(['rebuild'])).toBe(0);
    expect(await rowCount('documents')).toBeGreaterThan(0);

    const chunks = await rowCount('chunks');
    expect(chunks).toBeGreaterThan(0);

    expect(await runCli(['rebuild', '--purge'])).toBe(0);
    expect(await rowCount('documents')).toBe(0);
    expect(await rowCount('folders')).toBe(0);
    expect(await rowCount('assets')).toBe(0);
    expect(await rowCount('document_edges')).toBe(0);
    expect(await rowCount('chunks')).toBe(chunks);
  });
});

async function rowCount(table: string): Promise<number> {
  const rows = await getSequelize().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table}`,
    { type: QueryTypes.SELECT },
  );
  return Number(rows[0].count);
}

async function isInTheFuture(timestamp: string): Promise<boolean> {
  const rows = await getSequelize().query<{ future: boolean }>(
    `SELECT :ts::timestamptz > now() AS future`,
    { type: QueryTypes.SELECT, replacements: { ts: timestamp } },
  );
  return rows[0].future;
}

function enqueueSync(
  repoId: string,
  automatic: boolean,
  payload: Record<string, unknown> = {},
): Promise<boolean> {
  return queue.enqueue({
    tenantId: harness.tenantId,
    kind: 'sync-repo-content',
    payload: { repoId, ...payload },
    dedupeKey: `sync-repo-content:${repoId}`,
    automatic,
  });
}

async function setNewestStatus(repoId: string, status: string): Promise<void> {
  await getSequelize().query(
    `UPDATE jobs SET status = :status
      WHERE id = (SELECT id FROM jobs WHERE dedupe_key = :key ORDER BY created_at DESC LIMIT 1)`,
    { type: QueryTypes.UPDATE, replacements: { status, key: `sync-repo-content:${repoId}` } },
  );
}

async function statusesOf(repoId: string): Promise<string[]> {
  const rows = await getSequelize().query<{ status: string }>(
    `SELECT status FROM jobs WHERE dedupe_key = :key ORDER BY created_at`,
    { type: QueryTypes.SELECT, replacements: { key: `sync-repo-content:${repoId}` } },
  );
  return rows.map((row) => row.status);
}

async function pendingJobsOf(repoId: string) {
  return getSequelize().query<{ run_after: string; payload: Record<string, unknown> }>(
    `SELECT run_after, payload FROM jobs WHERE dedupe_key = :key AND status = 'pending'`,
    { type: QueryTypes.SELECT, replacements: { key: `sync-repo-content:${repoId}` } },
  );
}

async function jobRow(id: string) {
  const rows = await getSequelize().query<{
    status: string;
    run_after: string;
    last_error: string | null;
  }>(`SELECT status, run_after, last_error FROM jobs WHERE id = :id`, {
    type: QueryTypes.SELECT,
    replacements: { id },
  });
  return rows[0];
}

async function rebuildJobCount(): Promise<number> {
  const rows = await getSequelize().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM jobs WHERE kind = 'rebuild'`,
    { type: QueryTypes.SELECT },
  );
  return Number(rows[0].count);
}

async function contentHashes(): Promise<{ slug_path: string; content_hash: string }[]> {
  return getSequelize().query<{ slug_path: string; content_hash: string }>(
    `SELECT slug_path, content_hash FROM documents ORDER BY repo_id, slug_path`,
    { type: QueryTypes.SELECT },
  );
}
