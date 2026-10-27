import {
  DEFAULT_TEST_DATABASE_URL,
  assertTestDatabase,
  testDatabaseUrl,
} from '../helpers/test-database';

describe('the database the suite may destroy', () => {
  it('accepts a name that ends in _test', () => {
    expect(() => assertTestDatabase('speicher_test')).not.toThrow();
    expect(() => assertTestDatabase('other_test')).not.toThrow();
  });

  it('refuses the development database', () => {
    expect(() => assertTestDatabase('speicher')).toFailWith('test-database.refused');
  });

  it('refuses a name that merely contains _test', () => {
    expect(() => assertTestDatabase('speicher_test_fixtures')).toFailWith('test-database.refused');
  });

  it('names a URL that would work in the refusal', () => {
    expect(() => assertTestDatabase('speicher')).toThrow(DEFAULT_TEST_DATABASE_URL);
  });

  it('is the default when nothing is exported', () => {
    expect(testDatabaseUrl({} as NodeJS.ProcessEnv)).toBe(DEFAULT_TEST_DATABASE_URL);
  });

  it('is whatever an operator exported, since that is somebody saying which', () => {
    const url = 'postgres://u:p@example.test:5432/mine_test';
    expect(testDatabaseUrl({ SPEICHER_DATABASE_URL: url } as NodeJS.ProcessEnv)).toBe(url);
  });
});
