import { ensureDatabase, testDatabaseUrl } from './helpers/test-database';

export default async function globalSetup(): Promise<void> {
  const created = await ensureDatabase(testDatabaseUrl());
  if (created.status === 'created') {
    process.stderr.write(`test database: created ${created.database}\n`);
  }
}
