import { QueryInterface } from 'sequelize';

// A magic link sent from the setup wizard names its redeemer the first administrator
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.query(
    `ALTER TABLE magic_link_tokens ADD COLUMN names_first_admin boolean NOT NULL DEFAULT false`,
  );
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.query(`ALTER TABLE magic_link_tokens DROP COLUMN IF EXISTS names_first_admin`);
}
