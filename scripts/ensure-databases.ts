/*
 * Create test database if missing
 */
import { ensureDatabase, testDatabaseUrl } from '../test/helpers/test-database';

ensureDatabase(testDatabaseUrl())
  .then((result) => {
    if (result.status === 'created') process.stdout.write(`created database ${result.database}\n`);
    if (result.status === 'unreachable') {
      process.stderr.write(`ensure-databases: server not reachable, skipping (${result.detail})\n`);
    }
  })
  .catch((err: Error) => {
    process.stderr.write(`ensure-databases: ${err.message}\n`);
    process.exit(1);
  });
