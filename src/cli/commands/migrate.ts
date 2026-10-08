import { rootLogger } from '../../common/logger';
import { migrateDown, migrateUp, pendingMigrations } from '../../db/migrate';
import { Command, UsageError } from '../command-types';

const MIGRATE_ACTIONS = ['up', 'down', 'status'] as const;

export type MigrateAction = (typeof MIGRATE_ACTIONS)[number];

function isMigrateAction(value: string): value is MigrateAction {
  return (MIGRATE_ACTIONS as readonly string[]).includes(value);
}

export function parseMigrate(argv: string[]): MigrateAction {
  if (argv.length > 1) {
    throw new UsageError(`migrate: Expected at most one action, but received ${argv.length}.`);
  }
  const action = argv[0] ?? 'up';
  if (!isMigrateAction(action)) {
    throw new UsageError(
      `migrate: ${JSON.stringify(action)} is an unknown action. The actions are ${MIGRATE_ACTIONS.join(', ')}.`,
    );
  }
  return action;
}

export const migrateCommand: Command = {
  summary:
    'Applies or reverts database migrations. down reverts the last migration, up applies all pending migrations, status shows pending migrations.',
  args: '[up|down|status]',
  // Fresh install may lack a schema
  needsCurrentSchema: false,
  check: (argv) => void parseMigrate(argv),
  run: async (argv) => {
    const log = rootLogger.child('migrate');
    const action = parseMigrate(argv);
    if (action === 'up') {
      const applied = await migrateUp();
      log.info(applied.length ? 'migrations applied' : 'schema already current', { applied });
      return 0;
    }
    if (action === 'down') {
      log.info('migration reverted', { reverted: await migrateDown() });
      return 0;
    }
    const pending = await pendingMigrations();
    log.info('migration status', { pending, current: pending.length === 0 });
    // Exit code 1 reports pending to scripts
    return pending.length > 0 ? 1 : 0;
  },
};
