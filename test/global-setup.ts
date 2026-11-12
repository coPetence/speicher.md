import { Client } from 'pg';
import { Sequelize } from 'sequelize';

import { migrateUp } from '../src/db/migrate';
import { APP_ROLE, ensureDatabase, testDatabaseUrl } from './helpers/test-database';

export default async function globalSetup(): Promise<void> {
  const url = testDatabaseUrl();
  const created = await ensureDatabase(url);
  if (created.status === 'created') {
    process.stderr.write(`test database: created ${created.database}\n`);
  }
  // Unreachable: unit specs still run, and integration specs say why they cannot
  if (created.status !== 'unreachable') await prepareTestDatabase(url);
}

/**
 * Migrate the test database as its owner, then give `APP_ROLE` read/write access.
 *
 * Once per run, so the grants cover every table the migrations just created.
 */
async function prepareTestDatabase(ownerUrl: string): Promise<void> {
  const owner = new Sequelize(ownerUrl, { dialect: 'postgres', logging: false });
  try {
    await migrateUp(owner);
  } finally {
    await owner.close();
  }

  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    if (rows.length === 0) {
      await client.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE}'`);
    }
    await client.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    );
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
  } finally {
    await client.end();
  }
}
