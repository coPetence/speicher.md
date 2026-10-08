import { QueryInterface } from 'sequelize';

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;

  // Readers are counted, never recorded: `readers` is a HyperLogLog sketch
  await q.query(`
    CREATE TABLE page_views (
      tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      repo_id     uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      slug_path   text NOT NULL,
      bucket      timestamptz NOT NULL,
      granularity text NOT NULL,
      surface     text NOT NULL,
      views       bigint NOT NULL DEFAULT 0,
      readers     bytea,
      PRIMARY KEY (tenant_id, repo_id, slug_path, bucket, granularity, surface)
    )
  `);
  await q.query(`CREATE INDEX page_views_window ON page_views (tenant_id, bucket DESC)`);
  await q.query(`CREATE INDEX page_views_sweep ON page_views (tenant_id, granularity, bucket)`);

  await q.query(`
    CREATE TABLE search_misses (
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      query     text NOT NULL,
      bucket    timestamptz NOT NULL,
      misses    bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, query, bucket)
    )
  `);
  await q.query(`CREATE INDEX search_misses_sweep ON search_misses (tenant_id, bucket)`);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.query(`DROP TABLE IF EXISTS search_misses`);
  await q.query(`DROP TABLE IF EXISTS page_views`);
}
