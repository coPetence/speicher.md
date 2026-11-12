import { QueryInterface } from 'sequelize';

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;

  // Chunks do not have principals because they can only be read through a document which carries the principals
  // The vector column has no fixed width; embedding_dim is used to store width per vector
  await q.query(`
    CREATE TABLE chunks (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      repo_id         uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      slug_path       text NOT NULL,
      ord             integer NOT NULL,
      text            text NOT NULL,
      content_hash    text NOT NULL,
      embedding       vector,
      embedding_model text,
      embedding_dim   integer,
      created_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chunks_page_ord UNIQUE (tenant_id, repo_id, slug_path, ord)
    )
  `);
  await q.query(`CREATE INDEX chunks_page ON chunks (tenant_id, repo_id, slug_path)`);
  await q.query(`CREATE INDEX chunks_hash ON chunks (content_hash)`);
  // The embed job's queue: a chunk without a vector is work still to do
  await q.query(`CREATE INDEX chunks_pending ON chunks (tenant_id) WHERE embedding IS NULL`);
  await q.query(
    `CREATE INDEX chunks_text_trgm ON chunks USING gin (public.speicher_unaccent(text) gin_trgm_ops)`,
  );
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.query(`DROP TABLE IF EXISTS chunks`);
}
