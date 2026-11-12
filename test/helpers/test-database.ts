/*
 * Which database the test suite owns, how it comes to exist, and the guard that
 * keeps the suite from truncating any other.
 *
 * One module, so the database `ensureDatabase` creates and the one `test/setup.ts`
 * opens cannot come apart. `scripts/ensure-databases.ts` reads it too.
 */
import { CodedError } from '../../src/common/errors';

export const DEFAULT_TEST_DATABASE_URL =
  'postgres://speicher:speicher@127.0.0.1:55432/speicher_test';

export const TEST_DATABASE_SUFFIX = '_test';

/**
 * The URL the suite runs against.
 *
 * An exported `SPEICHER_DATABASE_URL` wins, because that is somebody saying which
 * database they mean — and `assertTestDatabase` is what keeps that from being the
 * development one.
 */
export function testDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPEICHER_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
}

/**
 * `truncateAll` empties every table, so it runs only against a database that says
 * it is a test database. No override.
 */
export function assertTestDatabase(name: string): void {
  if (name.endsWith(TEST_DATABASE_SUFFIX)) return;
  throw new CodedError(
    'test-database.refused',
    `refusing to truncate database "${name}": the test suite only runs against a ` +
      `database whose name ends in "${TEST_DATABASE_SUFFIX}". ` +
      `Unset SPEICHER_DATABASE_URL, or point it at ${DEFAULT_TEST_DATABASE_URL}.`,
  );
}

export interface EnsureResult {
  database: string;
  status: 'created' | 'present' | 'unreachable';
  detail?: string;
}

/**
 * Create the database if it is missing.
 *
 * Postgres in compose creates only the development database, and its init scripts
 * run only on an empty volume, so the test database is created here — from
 * `globalSetup`, and from `npm run db:up`.
 *
 * Idempotent, and it reports rather than throws when the server is not reachable:
 * failing would block a unit-only run whenever Docker is down, and the suite itself
 * says "connection refused" far more usefully than a prerequisite step does.
 */
export async function ensureDatabase(url = testDatabaseUrl()): Promise<EnsureResult> {
  // Imported here rather than at the top: `test/setup.ts` reads the URL from this
  // module for *every* spec, the island specs run under jsdom, and `pg` reaches for
  // `TextEncoder` at import time — which jsdom does not have.
  const { Client } = await import('pg');
  const database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  // The same server, addressed at a database that is known to exist.
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  const client = new Client({ connectionString: maintenance.toString() });
  try {
    await client.connect();
  } catch (err) {
    // Closed even though the connection failed. A `pg.Client` that could not
    // connect can still hold a socket, and this runs from `globalSetup` — where a
    // handle nothing closes keeps node alive after the last spec, which looks from
    // outside exactly like a suite that hangs.
    await client.end().catch(() => {});
    return { database, status: 'unreachable', detail: (err as Error).message };
  }
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (rows.length > 0) return { database, status: 'present' };
    // No parameters in DDL. The name comes from a URL an operator may have set, so
    // it is quoted rather than interpolated bare.
    await client.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
    return { database, status: 'created' };
  } finally {
    await client.end();
  }
}

/** The role the suite runs as: read and write rows, nothing else */
export const APP_ROLE = 'speicher_app_test';

/**
 * The URL the suite runs as: the test database, signed in as `APP_ROLE`.
 *
 * The application must work with read/write access alone, so every spec connects
 * this way, and a statement that needs more — DDL, TRUNCATE — fails the suite.
 * Migrating and emptying the tables are the owner's, through `ownerDatabaseUrl`.
 */
export function appRoleUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = APP_ROLE;
  url.password = APP_ROLE;
  return url.toString();
}

/** The owner URL `test/setup.ts` kept before pointing the app at `APP_ROLE` */
export function ownerDatabaseUrl(): string {
  return process.env.TEST_DATABASE_OWNER_URL || testDatabaseUrl();
}

/** Empty the given tables as the owner, since `APP_ROLE` may not TRUNCATE */
export async function truncateAsOwner(tables: string[]): Promise<void> {
  const ownerUrl = ownerDatabaseUrl();
  assertTestDatabase(decodeURIComponent(new URL(ownerUrl).pathname.replace(/^\//, '')));
  const { Client } = await import('pg');
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  } finally {
    await client.end();
  }
}
