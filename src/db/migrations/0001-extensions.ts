import { QueryInterface } from 'sequelize';

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
  await q.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await q.query(`CREATE EXTENSION IF NOT EXISTS vector`);

  // `unaccent()` is STABLE, so it cannot appear in a generated column or an index. The
  // two-argument form pinned to a named dictionary can be wrapped as IMMUTABLE.
  await q.query(`
    CREATE FUNCTION public.speicher_unaccent(text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE
      STRICT
      PARALLEL SAFE
    AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$
  `);
}

/** The extensions are left installed, since other databases on the server may use them. */
export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.query(`DROP FUNCTION IF EXISTS public.speicher_unaccent(text)`);
}
