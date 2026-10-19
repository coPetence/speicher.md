import type { INestApplication } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';

import { closeSequelize, databaseUrl, getSequelize } from '../../src/db/sequelize';
import { JobQueue } from '../../src/jobs/queue';
import { Worker } from '../../src/jobs/worker';
import { Harness, createHarness } from '../helpers/harness';
import { bootTestApp } from '../helpers/http';

let harness: Harness;
let app: INestApplication;
let queue: JobQueue;

beforeAll(async () => {
  harness = await createHarness();
  app = await bootTestApp();
  queue = app.get(JobQueue);
});

afterAll(async () => {
  await app.close();
  await harness.close();
  await closeSequelize();
});

beforeEach(async () => {
  await getSequelize().query('DELETE FROM jobs', { type: QueryTypes.DELETE });
});

async function rowsFor(
  dedupeKey: string,
): Promise<{ id: string; status: string; last_error: string | null }[]> {
  return getSequelize().query(
    'SELECT id, status, last_error FROM jobs WHERE dedupe_key = :dedupeKey ORDER BY created_at',
    { type: QueryTypes.SELECT, replacements: { dedupeKey } },
  );
}

function run(job: Awaited<ReturnType<JobQueue['claim']>>[number]): Promise<void> {
  return (app.get(Worker) as unknown as { run(row: typeof job): Promise<void> }).run(job);
}

describe('a job that fails while its follow-up is already queued', () => {
  it('is not retried, and the follow-up stays queued', async () => {
    const key = 'sync-repo-content:follow-up';
    await queue.enqueue({
      tenantId: harness.tenantId,
      kind: 'sync-repo-content',
      payload: { repoId: 'x' },
      dedupeKey: key,
    });
    const [running] = await queue.claim(1);
    await queue.enqueue({
      tenantId: harness.tenantId,
      kind: 'sync-repo-content',
      payload: { repoId: 'x' },
      dedupeKey: key,
    });

    await expect(queue.fail(running, 'boom')).resolves.toBeUndefined();

    const rows = await rowsFor(key);
    expect(rows.map((row) => row.status)).toEqual(['superseded', 'pending']);
    expect(rows[0].last_error).toBe('boom');
  });

  it('is still retried when nothing else is queued', async () => {
    const key = 'sync-repo-content:alone';
    await queue.enqueue({
      tenantId: harness.tenantId,
      kind: 'sync-repo-content',
      payload: { repoId: 'x' },
      dedupeKey: key,
    });
    const [running] = await queue.claim(1);

    await queue.fail(running, 'boom');

    expect((await rowsFor(key)).map((row) => row.status)).toEqual(['pending']);
  });

  it('does not stop the worker when recording the failure itself fails', async () => {
    await queue.enqueue({
      tenantId: harness.tenantId,
      kind: 'purge',
      payload: { repoId: 'not-a-uuid' },
    });
    const [job] = await queue.claim(1);
    const original = queue.fail.bind(queue);
    queue.fail = async () => {
      throw new Error('database went away');
    };
    try {
      await expect(run(job)).resolves.toBeUndefined();
    } finally {
      queue.fail = original;
    }
  });
});

// Every way a job returns to pending meets the same index: at most one pending job
// per key. A job whose work another pending job already covers becomes `superseded`.
describe('a job brought back to pending beside one with the same key', () => {
  async function deadJob(key: string): Promise<string> {
    await queue.enqueue({
      tenantId: harness.tenantId,
      kind: 'sync-repo-content',
      payload: { repoId: 'x' },
      dedupeKey: key,
      maxAttempts: 1,
    });
    const [job] = await queue.claim(1);
    await queue.fail(job, 'boom');
    return job.id;
  }

  it('is not retried by id when its follow-up is already queued', async () => {
    const key = 'sync-repo-content:retry-one';
    const dead = await deadJob(key);
    await queue.enqueue({
      tenantId: harness.tenantId,
      kind: 'sync-repo-content',
      payload: { repoId: 'x' },
      dedupeKey: key,
    });

    await expect(queue.retryDead({ tenantId: harness.tenantId, ids: [dead] })).resolves.toBe(0);
    expect((await rowsFor(key)).map((row) => row.status)).toEqual(['superseded', 'pending']);
  });

  it('comes back once when several dead jobs share the key, the newest of them', async () => {
    const key = 'sync-repo-content:retry-all';
    const older = await deadJob(key);
    const newer = await deadJob(key);

    await expect(queue.retryDead({ tenantId: harness.tenantId })).resolves.toBe(1);
    const rows = await rowsFor(key);
    expect(rows.find((row) => row.id === newer)?.status).toBe('pending');
    expect(rows.find((row) => row.id === older)?.status).toBe('superseded');
  });

  it('is not released to pending at shutdown when its follow-up is already queued', async () => {
    const key = 'sync-repo-content:release';
    await queue.enqueue({
      tenantId: harness.tenantId,
      kind: 'sync-repo-content',
      payload: { repoId: 'x' },
      dedupeKey: key,
    });
    await queue.claim(1);
    await queue.enqueue({
      tenantId: harness.tenantId,
      kind: 'sync-repo-content',
      payload: { repoId: 'x' },
      dedupeKey: key,
    });

    await expect(queue.releaseAll()).resolves.toBeUndefined();
    expect((await rowsFor(key)).map((row) => row.status)).toEqual(['superseded', 'pending']);
  });
});

describe('a content sync whose repository is already being synced', () => {
  it.failing('leaves a sync queued for afterwards rather than dropping it', async () => {
    const repoId = harness.repos.handbook;
    const key = `sync-repo-content:${repoId}`;
    const otherWorker = new JobQueue(
      new Sequelize(databaseUrl(), { dialect: 'postgres', logging: false }),
    );

    try {
      await otherWorker.withRepoLock(repoId, async () => {
        await queue.enqueue({
          tenantId: harness.tenantId,
          kind: 'sync-repo-content',
          payload: { repoId },
          dedupeKey: key,
        });
        const [job] = await queue.claim(1);
        await run(job);
      });

      const statuses = (await rowsFor(key)).map((row) => row.status);
      expect(statuses).toContain('pending');
    } finally {
      await (otherWorker as unknown as { sequelize: Sequelize }).sequelize.close();
    }
  });
});
