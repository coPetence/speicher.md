import { QueryInterface } from 'sequelize';

// API keys were never issuable outside the dev seed; MCP clients connect over OAuth
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.query(`DROP TABLE IF EXISTS api_keys`);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.query(`
    CREATE TABLE api_keys (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      principal     text NOT NULL,
      provider      text NOT NULL,
      subject       text NOT NULL,
      email         text,
      name          text NOT NULL,
      hash          text NOT NULL UNIQUE,
      scopes        text[] NOT NULL DEFAULT '{}',
      raw_group_ids text[] NOT NULL DEFAULT '{}',
      expires_at    timestamptz NOT NULL,
      last_used_at  timestamptz,
      revoked_at    timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT api_keys_never_admin CHECK (NOT ('admin' = ANY (scopes)))
    )
  `);
  await q.query(`CREATE INDEX api_keys_principal ON api_keys (tenant_id, principal)`);
}
