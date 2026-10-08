import { QueryInterface } from 'sequelize';

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;

  // Document ids change on every sync; anything kept across syncs keys on
  // (tenant_id, repo_id, slug_path) instead
  await q.query(`
    CREATE TABLE documents (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      repo_id              uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      slug_path            text NOT NULL,
      source_path          text NOT NULL,
      parent_path          text NOT NULL DEFAULT '',
      title                text NOT NULL,
      description          text,
      icon                 text,
      html                 text NOT NULL DEFAULT '',
      markdown             text NOT NULL DEFAULT '',
      plain                text NOT NULL DEFAULT '',
      is_index             boolean NOT NULL DEFAULT false,
      indexable            boolean NOT NULL DEFAULT true,
      effective_principals text[] NOT NULL DEFAULT '{}',
      config_source        jsonb NOT NULL DEFAULT '{}',
      content_hash         text NOT NULL,
      commit_sha           text NOT NULL,
      sort_order           integer,
      sort_key             text NOT NULL DEFAULT '',
      cover_path           text,
      repo_namespace       text NOT NULL DEFAULT '',
      repo_slug            text NOT NULL DEFAULT '',
      forge_key            text NOT NULL DEFAULT '',
      updated_at           timestamptz NOT NULL DEFAULT now(),
      tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('german', public.speicher_unaccent(coalesce(title, ''))), 'A') ||
        setweight(to_tsvector('german', public.speicher_unaccent(coalesce(description, ''))), 'B') ||
        setweight(to_tsvector('german', public.speicher_unaccent(coalesce(plain, ''))), 'C')
      ) STORED,
      tsv_simple tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', public.speicher_unaccent(coalesce(title, ''))), 'A') ||
        setweight(to_tsvector('simple', public.speicher_unaccent(coalesce(description, ''))), 'B') ||
        setweight(to_tsvector('simple', public.speicher_unaccent(coalesce(plain, ''))), 'C')
      ) STORED
    )
  `);
  await q.query(
    `CREATE UNIQUE INDEX documents_slug_uniq ON documents (tenant_id, repo_id, slug_path)`,
  );
  await q.query(`CREATE INDEX documents_parent ON documents (tenant_id, repo_id, parent_path)`);
  await q.query(
    `CREATE INDEX documents_principals_gin ON documents USING gin (effective_principals)`,
  );
  await q.query(`CREATE INDEX documents_tsv_gin ON documents USING gin (tsv)`);
  await q.query(`CREATE INDEX documents_tsv_simple_gin ON documents USING gin (tsv_simple)`);

  await q.query(`
    CREATE TABLE folders (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      repo_id              uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      slug_path            text NOT NULL,
      source_path          text NOT NULL,
      parent_path          text,
      title                text NOT NULL,
      icon                 text,
      sort_order           integer,
      sort_key             text NOT NULL DEFAULT '',
      cover_path           text,
      effective_principals text[] NOT NULL DEFAULT '{}',
      config_source        jsonb NOT NULL DEFAULT '{}',
      commit_sha           text NOT NULL,
      UNIQUE (tenant_id, repo_id, slug_path)
    )
  `);
  await q.query(`CREATE INDEX folders_parent ON folders (tenant_id, repo_id, parent_path)`);
  await q.query(`CREATE INDEX folders_principals_gin ON folders USING gin (effective_principals)`);

  await q.query(`
    CREATE TABLE assets (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      repo_id              uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      slug_path            text NOT NULL,
      source_path          text NOT NULL,
      parent_path          text NOT NULL DEFAULT '',
      mime                 text NOT NULL,
      size_bytes           bigint NOT NULL,
      effective_principals text[] NOT NULL DEFAULT '{}',
      content_hash         text NOT NULL,
      commit_sha           text NOT NULL,
      updated_at           timestamptz NOT NULL DEFAULT now()
    )
  `);
  await q.query(`CREATE UNIQUE INDEX assets_slug_uniq ON assets (tenant_id, repo_id, slug_path)`);
  await q.query(`CREATE INDEX assets_blob_key ON assets (repo_id, content_hash)`);
  await q.query(`CREATE INDEX assets_principals_gin ON assets USING gin (effective_principals)`);

  await q.query(`
    CREATE TABLE redirects (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      repo_id    uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      from_path  text NOT NULL,
      to_path    text NOT NULL,
      reason     text NOT NULL,
      retired_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await q.query(
    `CREATE UNIQUE INDEX redirects_from_uniq ON redirects (tenant_id, repo_id, from_path) WHERE retired_at IS NULL`,
  );

  // Edges and terms store no principals: every read joins `documents` at both ends
  await q.query(`
    CREATE TABLE document_edges (
      tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      repo_id          uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      source_slug_path text NOT NULL,
      kind             text NOT NULL,
      target_repo_id   uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      target_slug_path text NOT NULL,
      target_fragment  text NOT NULL DEFAULT '',
      ordinal          integer NOT NULL,
      commit_sha       text NOT NULL,
      PRIMARY KEY (tenant_id, repo_id, source_slug_path, kind, target_repo_id, target_slug_path, target_fragment)
    )
  `);
  await q.query(
    `CREATE INDEX document_edges_target ON document_edges (tenant_id, target_repo_id, target_slug_path, kind)`,
  );

  await q.query(`
    CREATE TABLE document_terms (
      tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      repo_id          uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      source_slug_path text NOT NULL,
      term             text NOT NULL,
      label            text NOT NULL,
      ordinal          integer NOT NULL,
      commit_sha       text NOT NULL,
      PRIMARY KEY (tenant_id, repo_id, source_slug_path, term)
    )
  `);
  await q.query(`CREATE INDEX document_terms_term ON document_terms (tenant_id, term)`);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  for (const table of [
    'document_terms',
    'document_edges',
    'redirects',
    'assets',
    'folders',
    'documents',
  ]) {
    await q.query(`DROP TABLE IF EXISTS ${table}`);
  }
}
