import { QueryInterface } from 'sequelize';

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;

  // Saves append and never update: this table is the instance's access-change history
  await q.query(`
    CREATE TABLE instance_configs (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      version         integer NOT NULL,
      yaml            text NOT NULL,
      resolution_hash text NOT NULL,
      origin          text NOT NULL,
      applied_by      text,
      applied_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, version),
      CONSTRAINT instance_configs_version_positive CHECK (version > 0),
      CONSTRAINT instance_configs_origin CHECK (origin IN ('file', 'admin', 'setup'))
    )
  `);

  await q.query(`
    CREATE TABLE setup_claims (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code        text NOT NULL,
      token_hash  text NOT NULL UNIQUE,
      origin      text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL,
      approved_at timestamptz,
      redeemed_at timestamptz
    )
  `);
  await q.query(`CREATE UNIQUE INDEX setup_claims_code ON setup_claims (tenant_id, code)`);
  await q.query(`CREATE INDEX setup_claims_expiry ON setup_claims (expires_at)`);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.query(`DROP TABLE IF EXISTS setup_claims`);
  await q.query(`DROP TABLE IF EXISTS instance_configs`);
}
