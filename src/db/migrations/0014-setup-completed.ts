import { QueryInterface } from 'sequelize';

// The guided setup ends when an administrator who can read a synced page completes it, no longer at the first administrator login
export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.query(`ALTER TABLE tenants ADD COLUMN setup_completed_at timestamptz`);
  // Instances set up before keep their setup finished
  await q.query(
    `UPDATE tenants SET setup_completed_at = first_admin_login_at WHERE first_admin_login_at IS NOT NULL`,
  );
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.query(`ALTER TABLE tenants DROP COLUMN IF EXISTS setup_completed_at`);
}
