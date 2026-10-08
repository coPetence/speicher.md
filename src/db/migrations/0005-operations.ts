import { QueryInterface } from 'sequelize';

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;

  await q.query(`
    CREATE TABLE sync_runs (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      repo_id     uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      sha         text,
      trigger     text NOT NULL DEFAULT 'manual',
      status      text NOT NULL DEFAULT 'running',
      stats       jsonb NOT NULL DEFAULT '{}',
      findings    jsonb NOT NULL DEFAULT '[]',
      error       text,
      started_at  timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    )
  `);
  await q.query(`CREATE INDEX sync_runs_repo ON sync_runs (repo_id, started_at DESC)`);

  await q.query(`
    CREATE TABLE jobs (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      kind         text NOT NULL,
      payload      jsonb NOT NULL DEFAULT '{}',
      dedupe_key   text,
      status       text NOT NULL DEFAULT 'pending',
      run_after    timestamptz NOT NULL DEFAULT now(),
      attempts     integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 5,
      locked_until timestamptz,
      locked_by    text,
      last_error   text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    )
  `);
  await q.query(`CREATE INDEX jobs_claimable ON jobs (status, run_after) WHERE status = 'pending'`);
  await q.query(`CREATE INDEX jobs_dead ON jobs (status) WHERE status = 'dead'`);
  // Only one pending job per dedupe key; a running or finished one does not block a new one
  await q.query(
    `CREATE UNIQUE INDEX jobs_dedupe ON jobs (tenant_id, kind, dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL`,
  );

  await q.query(`
    CREATE TABLE notification_state (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      subject_key  text NOT NULL,
      kind         text NOT NULL,
      last_state   text NOT NULL,
      last_sent_at timestamptz,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, kind, subject_key)
    )
  `);

  await q.query(`
    CREATE TABLE instance_state (
      key        text PRIMARY KEY,
      value      jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await q.query(`
    CREATE TABLE rate_limits (
      bucket       text NOT NULL,
      window_start timestamptz NOT NULL,
      count        integer NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket, window_start)
    )
  `);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  for (const table of [
    'rate_limits',
    'instance_state',
    'notification_state',
    'jobs',
    'sync_runs',
  ]) {
    await q.query(`DROP TABLE IF EXISTS ${table}`);
  }
}
