import { QueryTypes } from 'sequelize';

import { assertSchemaCurrent, pendingMigrations } from '../../src/db/migrate';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { APP_ROLE } from '../helpers/test-database';

afterAll(async () => {
  await closeSequelize();
});

describe('the application with read/write access only', () => {
  it('is how the suite connects', async () => {
    const [row] = await getSequelize().query<{ user: string }>(`SELECT current_user AS user`, {
      type: QueryTypes.SELECT,
    });
    expect(row.user).toBe(APP_ROLE);
  });

  it('cannot change the schema, so no spec can pass by doing so', async () => {
    // 42501: insufficient_privilege
    await expect(
      getSequelize().query(`CREATE TABLE app_role_probe (id int)`),
    ).rejects.toMatchObject({ original: { code: '42501' } });
    await expect(
      getSequelize().query(`ALTER TABLE chunks ADD COLUMN app_role_probe int`),
    ).rejects.toMatchObject({ original: { code: '42501' } });
  });

  it('checks the schema at startup without creating anything', async () => {
    await expect(pendingMigrations()).resolves.toEqual([]);
    await expect(assertSchemaCurrent()).resolves.toBeUndefined();
  });
});
