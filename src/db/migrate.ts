import { join } from 'node:path';

import { QueryInterface, Sequelize } from 'sequelize';
import { SequelizeStorage, Umzug } from 'umzug';

import { getSequelize } from './sequelize';

/**
 * Umzug migrator wired to the database
 *
 * Migrations live in src/db/migrations, one file per step
 * The storage table `schema_migrations` records which have been applied
 * Logger disabled to keep output quiet
 */
export function buildUmzug(sequelize: Sequelize = getSequelize()) {
  return new Umzug({
    migrations: {
      // Picks up both `.ts` (dev) and `.js` (production build)
      glob: join(__dirname, 'migrations', '*.{ts,js}'),

      resolve: ({ name, path, context }) => {
        // Dynamic require because the runtime extension is unknown at build time
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const migration = require(path as string) as {
          up(args: { context: QueryInterface }): Promise<void>;
          down(args: { context: QueryInterface }): Promise<void>;
        };
        return {
          // Strips the file extension to keep the name clean
          name: name.replace(/\.(ts|js)$/, ''),
          up: async () => migration.up({ context }),
          down: async () => migration.down({ context }),
        };
      },
    },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize, tableName: 'schema_migrations' }),
    logger: undefined,
  });
}

/**
 * Apply all pending migrations
 */
export async function migrateUp(sequelize?: Sequelize): Promise<string[]> {
  const umzug = buildUmzug(sequelize);
  const applied = await umzug.up();
  return applied.map((m) => m.name);
}

/**
 * Revert the last batch of migrations
 */
export async function migrateDown(sequelize?: Sequelize): Promise<string[]> {
  const umzug = buildUmzug(sequelize);
  const reverted = await umzug.down();
  return reverted.map((m) => m.name);
}

/**
 * List migration names that have not been applied yet
 */
export async function pendingMigrations(sequelize?: Sequelize): Promise<string[]> {
  const umzug = buildUmzug(sequelize);
  return (await umzug.pending()).map((m) => m.name);
}

/**
 * Thrown when the database schema is older than the code
 *
 * Migrations run as a pre-deploy job; the app will not apply them automatically
 */
export class SchemaMismatchError extends Error {
  constructor(readonly pending: string[]) {
    super(
      `database schema is behind the application: ${pending.length} migration(s) pending ` +
        `(${pending.join(', ')}). Migrations run as a pre-deploy job; the app will not apply them.`,
    );
    this.name = 'SchemaMismatchError';
  }
}

/**
 * Throw SchemaMismatchError if any migrations are still pending
 */
export async function assertSchemaCurrent(sequelize?: Sequelize): Promise<void> {
  const pending = await pendingMigrations(sequelize);
  if (pending.length > 0) throw new SchemaMismatchError(pending);
}
