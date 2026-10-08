import { QueryInterface } from 'sequelize';

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;

  await q.query(`
    CREATE TABLE tenants (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug                 text NOT NULL UNIQUE,
      hostname             text,
      first_admin_login_at timestamptz,
      setup_reopened_at    timestamptz,
      setup_reopen_count   integer NOT NULL DEFAULT 0,
      created_at           timestamptz NOT NULL DEFAULT now()
    )
  `);
  await q.query(`INSERT INTO tenants (slug) VALUES ('default')`);

  await q.query(`
    CREATE TABLE forges (
      id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      key                      text NOT NULL,
      type                     text NOT NULL,
      is_primary               boolean NOT NULL DEFAULT false,
      default_repository_owner text,
      config                   jsonb NOT NULL DEFAULT '{}',
      created_at               timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, key)
    )
  `);

  await q.query(`
    CREATE TABLE installations (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      forge_id              uuid NOT NULL REFERENCES forges(id) ON DELETE CASCADE,
      forge_installation_id text NOT NULL,
      namespace             text NOT NULL,
      namespace_id          text,
      account_type          text NOT NULL DEFAULT 'organization',
      suspended_at          timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, forge_id, forge_installation_id)
    )
  `);

  await q.query(`
    CREATE TABLE repos (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      forge_id              uuid NOT NULL REFERENCES forges(id) ON DELETE CASCADE,
      installation_id       uuid REFERENCES installations(id) ON DELETE SET NULL,
      forge_repo_id         text NOT NULL,
      namespace             text NOT NULL,
      namespace_id          text,
      slug                  text NOT NULL,
      branch                text NOT NULL DEFAULT '',
      ingest_root           text NOT NULL DEFAULT '',
      display_title         text,
      cover_path            text,
      maintainer_principals text[] NOT NULL DEFAULT '{}',
      has_config            boolean NOT NULL DEFAULT false,
      poll_interval_ms      integer,
      last_sha              text,
      last_run_at           timestamptz,
      last_status           text NOT NULL DEFAULT 'never',
      last_error            text,
      last_error_public     text,
      next_grant_review_at  timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, forge_id, forge_repo_id),
      UNIQUE (tenant_id, forge_id, namespace, slug),
      CONSTRAINT repos_poll_interval_positive CHECK (poll_interval_ms IS NULL OR poll_interval_ms > 0)
    )
  `);
  await q.query(`CREATE INDEX repos_last_run ON repos (last_run_at)`);
  await q.query(
    `CREATE INDEX repos_next_grant_review ON repos (next_grant_review_at) WHERE next_grant_review_at IS NOT NULL`,
  );

  // An old slug keeps redirecting to the repository until another repository takes it
  await q.query(`
    CREATE TABLE repo_slug_history (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      repo_id            uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      namespace          text NOT NULL,
      old_slug           text NOT NULL,
      retired_at         timestamptz,
      retired_by_repo_id uuid REFERENCES repos(id) ON DELETE SET NULL,
      created_at         timestamptz NOT NULL DEFAULT now()
    )
  `);
  await q.query(
    `CREATE INDEX repo_slug_history_lookup ON repo_slug_history (tenant_id, namespace, old_slug) WHERE retired_at IS NULL`,
  );

  await q.query(`
    CREATE TABLE webhook_deliveries (
      forge_id    uuid NOT NULL REFERENCES forges(id) ON DELETE CASCADE,
      delivery_id text NOT NULL,
      event       text,
      received_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (forge_id, delivery_id)
    )
  `);
  await q.query(`CREATE INDEX webhook_deliveries_received ON webhook_deliveries (received_at)`);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  for (const table of [
    'webhook_deliveries',
    'repo_slug_history',
    'repos',
    'installations',
    'forges',
    'tenants',
  ]) {
    await q.query(`DROP TABLE IF EXISTS ${table}`);
  }
}
