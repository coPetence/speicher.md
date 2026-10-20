import { QueryInterface } from 'sequelize';

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;

  await q.query(`ALTER TABLE magic_link_tokens ADD COLUMN redirect_to text`);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.query(`ALTER TABLE magic_link_tokens DROP COLUMN IF EXISTS redirect_to`);
}
