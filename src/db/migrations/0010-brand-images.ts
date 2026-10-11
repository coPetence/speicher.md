import { QueryInterface } from 'sequelize';

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;

  await q.query(`
    CREATE TABLE brand_images (
      tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      hash       text NOT NULL,
      media_type text NOT NULL,
      bytes      bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, hash),
      -- A backstop, not the policy: the per-field limits are the app's, and this
      -- is only here so a bug cannot store something a page would then serve.
      CONSTRAINT brand_images_bytes_bounded CHECK (
        octet_length(bytes) > 0 AND octet_length(bytes) <= 1048576
      )
    )
  `);

  // The sweep asks for rows past the grace period, per tenant
  await q.query(`CREATE INDEX brand_images_sweep ON brand_images (tenant_id, created_at)`);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.query(`DROP TABLE IF EXISTS brand_images`);
}
