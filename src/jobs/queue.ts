/**
 * PostgreSQL-backed job queue with deduplication, visibility timeout, and retry
 *
 * Jobs row-level locked via `SKIP LOCKED` so multiple workers poll safely
 * Deduplication uses a composite unique partial index on (tenant_id, kind, dedupe_key)
 * where status = 'pending' and the key is not null
 *
 * Advisory locks guard repo-scoped operations that must not run concurrently
 * across workers, not tied to a specific job row
 * Not using an external queue to avoid infrastructure and keep transactional
 * semantics with the application database
 */

import { randomUUID } from 'node:crypto';

import { QueryTypes, Sequelize, UniqueConstraintError } from 'sequelize';

import { Logger, rootLogger } from '../common/logger';
import { toPgTextArray } from '../db/pg-array';
import { getSequelize } from '../db/sequelize';

export const JOB_KINDS = [
  'sync-repo-content',
  'sync-repo-list',
  'purge',
  'purge-forge',
  'validate-pr',
  'rename',
  'rebuild',
  'reconcile',
  'notify',
  'embed',
  'analytics-maintenance',
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ['pending', 'running', 'done', 'dead', 'superseded'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export function isJobKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value);
}

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}

export interface JobRow {
  id: string;
  tenant_id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface JobListRow {
  id: string;
  kind: JobKind;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
  last_error: string | null;
  run_after: Date;
  updated_at: Date;
}

export interface EnqueueOptions {
  tenantId: string;
  kind: JobKind;
  payload?: Record<string, unknown>;
  /** When set, the job is a singleton per (tenant, kind, key); enqueueing again
   *  debounces the run time to the earlier of the two */
  dedupeKey?: string;
  /** Milliseconds from now to defer execution */
  runAfterMs?: number;
  maxAttempts?: number;
}

/** How long a worker can hold a claimed job before another worker may re-claim it */
export const VISIBILITY_TIMEOUT_MS = 15 * 60 * 1000;

export class JobQueue {
  private readonly log: Logger = rootLogger.child('jobs');
  readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(private readonly sequelize: Sequelize = getSequelize()) {}

  /** Insert or upsert a pending job */
  async enqueue(options: EnqueueOptions): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO jobs (tenant_id, kind, payload, dedupe_key, run_after, max_attempts)
       VALUES (
         :tenantId, :kind, CAST(:payload AS jsonb), :dedupeKey,
         now() + make_interval(secs => :delaySeconds), :maxAttempts
       )
       ON CONFLICT (tenant_id, kind, dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL
       DO UPDATE SET
         -- Debounce: an already-queued job keeps the earlier of the two run times,
         -- so a burst does not push its own execution further and further out.
         run_after = LEAST(jobs.run_after, EXCLUDED.run_after),
         payload   = EXCLUDED.payload,
         updated_at = now()`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          tenantId: options.tenantId,
          kind: options.kind,
          payload: JSON.stringify(options.payload ?? {}),
          dedupeKey: options.dedupeKey ?? null,
          delaySeconds: (options.runAfterMs ?? 0) / 1000,
          maxAttempts: options.maxAttempts ?? 5,
        },
      },
    );
  }

  /** Claim up to `limit` jobs for exclusive processing */
  async claim(limit = 1): Promise<JobRow[]> {
    return this.sequelize.query<JobRow>(
      `UPDATE jobs SET
         status = 'running',
         attempts = attempts + 1,
         locked_until = now() + make_interval(secs => :visibilitySeconds),
         locked_by = :workerId,
         updated_at = now()
       WHERE id IN (
         SELECT id FROM jobs
          WHERE (status = 'pending' AND run_after <= now())
             OR (status = 'running' AND locked_until < now())
          ORDER BY run_after
          FOR UPDATE SKIP LOCKED
          LIMIT :limit
       )
       RETURNING id, tenant_id, kind, payload, attempts, max_attempts`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          limit,
          workerId: this.workerId,
          visibilitySeconds: VISIBILITY_TIMEOUT_MS / 1000,
        },
      },
    );
  }

  /** Mark a job as done */
  async complete(jobId: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE jobs SET status = 'done', locked_until = NULL, locked_by = NULL, updated_at = now()
        WHERE id = :jobId`,
      { type: QueryTypes.UPDATE, replacements: { jobId } },
    );
  }

  /** Mark a job as failed; dead-letter if max attempts reached, else exponential backoff */
  async fail(job: JobRow, error: string): Promise<void> {
    if (job.attempts >= job.max_attempts) {
      await this.sequelize.query(
        `UPDATE jobs SET
           status = 'dead', last_error = :error, locked_until = NULL, locked_by = NULL,
           updated_at = now()
         WHERE id = :jobId`,
        { type: QueryTypes.UPDATE, replacements: { jobId: job.id, error } },
      );
      this.log.error('job dead-lettered', { kind: job.kind, attempts: job.attempts, error });
      return;
    }

    const backoffSeconds = Math.min(2 ** job.attempts * 5, 30 * 60);
    const { superseded } = await this.requeue([job.id], {
      runAfterSeconds: backoffSeconds,
      fresh: false,
      error,
    });
    if (superseded > 0) {
      this.log.info(
        'failed job will not be retried: a queued job with the same key already exists',
        {
          kind: job.kind,
          error,
        },
      );
    }
  }

  /**
   * Puts each job back to pending, in the order given. If a job's key already has a
   * pending job, it is marked `superseded` instead.
   *
   * `fresh` resets the job's attempt count and last error.
   */
  private async requeue(
    ids: string[],
    options: { runAfterSeconds: number; fresh: boolean; error?: string },
  ): Promise<{ requeued: number; superseded: number }> {
    let requeued = 0;
    for (const id of ids) {
      try {
        await this.setPending(id, options);
        requeued += 1;
      } catch (err) {
        if (!isDedupeConflict(err)) throw err;
        await this.setSuperseded(id, options.error);
      }
    }
    return { requeued, superseded: ids.length - requeued };
  }

  private async setPending(
    jobId: string,
    options: { runAfterSeconds: number; fresh: boolean; error?: string },
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE jobs SET
         status = 'pending',
         run_after = now() + make_interval(secs => :runAfterSeconds),
         attempts = CASE WHEN :fresh THEN 0 ELSE attempts END,
         last_error = CASE WHEN :fresh THEN NULL ELSE COALESCE(:error, last_error) END,
         locked_until = NULL,
         locked_by = NULL,
         updated_at = now()
       WHERE id = :jobId`,
      {
        type: QueryTypes.UPDATE,
        replacements: {
          jobId,
          runAfterSeconds: options.runAfterSeconds,
          fresh: options.fresh,
          error: options.error ?? null,
        },
      },
    );
  }

  private async setSuperseded(jobId: string, error?: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE jobs SET
         status = 'superseded',
         last_error = COALESCE(:error, last_error),
         locked_until = NULL,
         locked_by = NULL,
         updated_at = now()
       WHERE id = :jobId`,
      { type: QueryTypes.UPDATE, replacements: { jobId, error: error ?? null } },
    );
  }

  async withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T | null> {
    return this.withAdvisoryLock(repoId, fn);
  }

  /** Execute `fn` under a PostgreSQL advisory lock; returns null if not acquired */
  async withAdvisoryLock<T>(id: string, fn: () => Promise<T>): Promise<T | null> {
    const key = advisoryKey(id);
    const manager = this.sequelize.connectionManager;
    const connection = (await manager.getConnection({ type: 'write' })) as {
      query(sql: string, values?: unknown[]): Promise<{ rows: { locked: boolean }[] }>;
    };

    try {
      const acquired = await connection.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
      if (!acquired.rows[0]?.locked) {
        this.log.debug('already locked by another worker', { lock_id: id });
        return null;
      }
      try {
        return await fn();
      } finally {
        await connection.query('SELECT pg_advisory_unlock($1)', [key]);
      }
    } finally {
      manager.releaseConnection(connection);
    }
  }

  /** Reset dead jobs back to pending; returns how many came back */
  async retryDead(options: { tenantId: string; id?: string; kind?: JobKind }): Promise<number> {
    const dead = await this.sequelize.query<{ id: string }>(
      `SELECT id FROM jobs
        WHERE tenant_id = :tenantId AND status = 'dead'
          AND (:id::text IS NULL OR id::text = :id::text)
          AND (:kind::text IS NULL OR kind = :kind::text)
        ORDER BY updated_at DESC`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId: options.tenantId,
          id: options.id ?? null,
          kind: options.kind ?? null,
        },
      },
    );
    const { requeued, superseded } = await this.requeue(
      dead.map((row) => row.id),
      { runAfterSeconds: 0, fresh: true },
    );
    if (superseded > 0) {
      this.log.info('dead jobs not retried: a queued job with the same key already exists', {
        count: superseded,
      });
    }
    return requeued;
  }

  /** Delete pending jobs naming a forge or one of its repos; returns how many */
  async deletePendingJobsForForge(
    tenantId: string,
    forgeKey: string,
    repoIds: string[],
  ): Promise<number> {
    const deleted = await this.sequelize.query<{ id: string }>(
      `DELETE FROM jobs
        WHERE tenant_id = :tenantId AND status = 'pending'
          AND (payload->>'forgeKey' = :forgeKey
               OR payload->>'repoId' = ANY(CAST(:repoIds AS text[])))
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, forgeKey, repoIds: toPgTextArray(repoIds) },
      },
    );
    return deleted.length;
  }

  /** List recent jobs for a tenant, optionally filtered by status */
  async list(options: {
    tenantId: string;
    status?: string;
    limit?: number;
  }): Promise<JobListRow[]> {
    return this.sequelize.query<JobListRow>(
      `SELECT id, kind, status, attempts, max_attempts, payload, last_error, run_after, updated_at
         FROM jobs
        WHERE tenant_id = :tenantId AND (:status::text IS NULL OR status = :status::text)
        ORDER BY updated_at DESC
        LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId: options.tenantId,
          status: options.status ?? null,
          limit: options.limit ?? 50,
        },
      },
    );
  }

  /** Release all jobs and advisory locks held by this worker */
  async releaseAll(): Promise<void> {
    const held = await this.sequelize.query<{ id: string }>(
      `SELECT id FROM jobs WHERE locked_by = :workerId AND status = 'running'
        ORDER BY updated_at DESC`,
      { type: QueryTypes.SELECT, replacements: { workerId: this.workerId } },
    );
    await this.requeue(
      held.map((row) => row.id),
      { runAfterSeconds: 0, fresh: false },
    );
    await this.sequelize.query(`SELECT pg_advisory_unlock_all()`, { type: QueryTypes.SELECT });
  }

  /** Aggregate counts by status */
  async depth(): Promise<{ pending: number; running: number; dead: number }> {
    const rows = await this.sequelize.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM jobs GROUP BY status`,
      { type: QueryTypes.SELECT },
    );
    const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
    return { pending: by.pending ?? 0, running: by.running ?? 0, dead: by.dead ?? 0 };
  }
}

function isDedupeConflict(err: unknown): boolean {
  return (
    err instanceof UniqueConstraintError &&
    (err.parent as { constraint?: string } | undefined)?.constraint === 'jobs_dedupe'
  );
}

/**
 * Deterministic 64-bit signed integer from a string, for pg advisory locks
 *
 * Postgres pg_try_advisory_lock takes a bigint; hashing avoids the 2^63
 * key space limit and prevents accidental collisions with other lock uses
 */
export function advisoryKey(id: string): string {
  let hash = 0n;
  for (const char of id) {
    hash = (hash * 131n + BigInt(char.charCodeAt(0))) % 9223372036854775783n;
  }
  return hash.toString();
}
