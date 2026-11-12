import { join } from 'node:path';

import { QueryInterface, QueryTypes, Sequelize } from 'sequelize';
import { SequelizeStorage, Umzug, UmzugStorage } from 'umzug';

import { getSequelize } from './sequelize';

const MIGRATIONS_TABLE = 'schema_migrations';

/**
 * Umzug migrator wired to the database
 *
 * Migrations in src/db/migrations
 */
export function buildUmzug(sequelize: Sequelize = getSequelize(), { readOnly = false } = {}) {
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
    storage: readOnly
      ? new ReadOnlyStorage(sequelize)
      : new SequelizeStorage({ sequelize, tableName: MIGRATIONS_TABLE }),
    logger: undefined,
  });
}

/**
 * Reads applied migrations with a plain SELECT
 * Read-only, so web and worker only require read/write access to the schema_migrations table (no DDL rights)
 */
class ReadOnlyStorage implements UmzugStorage {
  constructor(private readonly sequelize: Sequelize) {}

  async executed(): Promise<string[]> {
    const [table] = await this.sequelize.query<{ present: boolean }>(
      `SELECT to_regclass(:table) IS NOT NULL AS present`,
      { type: QueryTypes.SELECT, replacements: { table: MIGRATIONS_TABLE } },
    );
    // No table yet: nothing has been applied
    if (!table.present) return [];
    const rows = await this.sequelize.query<{ name: string }>(
      `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name`,
      { type: QueryTypes.SELECT },
    );
    return rows.map((row) => row.name);
  }

  async logMigration(): Promise<void> {
    throw new Error('the schema check cannot record migrations; run `speicher migrate up`');
  }

  async unlogMigration(): Promise<void> {
    throw new Error('the schema check cannot revert migrations; run `speicher migrate down`');
  }
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
 *
 * Read-only, so web and worker only require read/write access to the schema_migrations table (no DDL rights)
 */
export async function pendingMigrations(sequelize?: Sequelize): Promise<string[]> {
  const umzug = buildUmzug(sequelize, { readOnly: true });
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
