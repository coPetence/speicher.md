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
    throw new UsageError(
      'usage.argument-count',
      `migrate: Too many actions (${argv.length}). Use one: ${MIGRATE_ACTIONS.join(', ')}.`,
    );
  }
  const action = argv[0] ?? 'up';
  if (!isMigrateAction(action)) {
    throw new UsageError(
      'usage.unknown-action',
      `migrate: Unknown action ${JSON.stringify(action)}. Use: ${MIGRATE_ACTIONS.join(', ')}.`,
      action,
    );
  }
  return action;
}

export const migrateCommand: Command = {
  summary:
    'Manage database migrations: up applies pending migrations (default), down reverts the last, status lists pending migrations.',
  args: '[up|down|status]',
  // Allow fresh installs without a schema
  needsCurrentSchema: false,
  check: (argv) => void parseMigrate(argv),
  run: async (argv) => {
    const log = rootLogger.child('migrate');
    const action = parseMigrate(argv);
    if (action === 'up') {
      const applied = await migrateUp();
      log.info(applied.length ? 'Migrations applied' : 'Database is up to date', { applied });
      return 0;
    }
    if (action === 'down') {
      log.info('Last migration reverted', { reverted: await migrateDown() });
      return 0;
    }
    const pending = await pendingMigrations();
    log.info(pending.length ? 'Pending migrations' : 'Database is up to date', {
      pending,
      current: pending.length === 0,
    });
    // Signal pending migrations with exit code 1
    return pending.length > 0 ? 1 : 0;
  },
};
