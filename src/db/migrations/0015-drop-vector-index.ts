import { QueryInterface } from 'sequelize';

// In prior versions, we built an ANN index on the chunks table. This was not used by the search query,
// and it tied the migration to the config and the app to DDL rights.
// this mutation removes it from instances that ran this step
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.query(`DROP INDEX IF EXISTS chunks_embedding_ann`);
  await q.query(`ALTER TABLE chunks ALTER COLUMN embedding TYPE vector`);
}

// The index is not rebuilt because no longer used
export async function down(): Promise<void> {}
