import { QueryInterface } from 'sequelize';

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;

  await q.query(`
    CREATE TABLE sessions (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      token_hash        text NOT NULL UNIQUE,
      provider          text NOT NULL,
      subject           text NOT NULL,
      email             text,
      display_name      text,
      raw_group_ids     text[] NOT NULL DEFAULT '{}',
      groups_fetched_at timestamptz,
      is_setup          boolean NOT NULL DEFAULT false,
      created_at        timestamptz NOT NULL DEFAULT now(),
      expires_at        timestamptz NOT NULL
    )
  `);
  await q.query(`CREATE INDEX sessions_expiry ON sessions (expires_at)`);

  await q.query(`
    CREATE TABLE magic_link_tokens (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      provider        text NOT NULL,
      email           text NOT NULL,
      token_hash      text NOT NULL UNIQUE,
      browser_binding text,
      expires_at      timestamptz NOT NULL,
      consumed_at     timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now()
    )
  `);
  await q.query(
    `CREATE INDEX magic_link_email ON magic_link_tokens (tenant_id, email, created_at DESC)`,
  );

  // Speicher as an OIDC client. `oauth_codes` below is Speicher as a server, kept apart
  await q.query(`
    CREATE TABLE login_flows (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      provider          text NOT NULL,
      state             text NOT NULL UNIQUE,
      nonce             text NOT NULL,
      code_verifier     text NOT NULL,
      redirect_to       text NOT NULL DEFAULT '/',
      names_first_admin boolean NOT NULL DEFAULT false,
      expires_at        timestamptz NOT NULL,
      created_at        timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Bearer credentials never carry admin scope (rule 8), enforced here as well
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

  await q.query(`
    CREATE TABLE oauth_codes (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code_hash      text NOT NULL UNIQUE,
      client_id      text NOT NULL,
      client_name    text,
      redirect_uri   text NOT NULL,
      resource       text NOT NULL,
      scope          text NOT NULL DEFAULT 'read',
      code_challenge text NOT NULL,
      provider       text NOT NULL,
      subject        text NOT NULL,
      email          text,
      raw_group_ids  text[] NOT NULL DEFAULT '{}',
      expires_at     timestamptz NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now()
    )
  `);

  await q.query(`
    CREATE TABLE oauth_grants (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      principal          text NOT NULL,
      client_id          text NOT NULL,
      client_name        text,
      resource           text NOT NULL,
      access_hash        text NOT NULL UNIQUE,
      refresh_hash       text UNIQUE,
      scopes             text[] NOT NULL DEFAULT '{}',
      provider           text NOT NULL,
      subject            text NOT NULL,
      email              text,
      raw_group_ids      text[] NOT NULL DEFAULT '{}',
      access_expires_at  timestamptz NOT NULL,
      refresh_expires_at timestamptz,
      last_used_at       timestamptz,
      revoked_at         timestamptz,
      created_at         timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT oauth_grants_never_admin CHECK (NOT ('admin' = ANY (scopes)))
    )
  `);
  await q.query(`CREATE INDEX oauth_grants_principal ON oauth_grants (tenant_id, principal)`);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  for (const table of [
    'oauth_grants',
    'oauth_codes',
    'api_keys',
    'login_flows',
    'magic_link_tokens',
    'sessions',
  ]) {
    await q.query(`DROP TABLE IF EXISTS ${table}`);
  }
}
