import type { TokenCredential } from '@azure/identity';
import { Sequelize } from 'sequelize';

import { AzureCredentialConfig } from '../../src/common/azure-credential';
import { POSTGRES_ENTRA_SCOPE } from '../../src/db/entra-token';
import { databaseAuthHooks, databaseUrl } from '../../src/db/sequelize';

describe('database sign-in with an Entra token', () => {
  const saved = {
    auth: process.env.SPEICHER_DATABASE_AUTH,
    clientId: process.env.SPEICHER_DATABASE_CLIENT_ID,
  };
  afterEach(() => {
    for (const [name, value] of [
      ['SPEICHER_DATABASE_AUTH', saved.auth],
      ['SPEICHER_DATABASE_CLIENT_ID', saved.clientId],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  // The local server takes a password, so the "token" is that password, and the
  // URL carries a wrong one: connecting proves the token is what signs in
  function fakeEntra() {
    const url = new URL(databaseUrl());
    const token = decodeURIComponent(url.password);
    url.password = 'not-the-password';
    const seen: { config?: AzureCredentialConfig; scopes: (string | string[])[] } = { scopes: [] };
    const credentialFor = (config: AzureCredentialConfig): TokenCredential => {
      seen.config = config;
      return {
        getToken: async (scope) => {
          seen.scopes.push(scope);
          return { token, expiresOnTimestamp: Date.now() + 60 * 60_000 };
        },
      };
    };
    return { url: url.href, credentialFor, seen };
  }

  it('signs in with the token instead of the URL password', async () => {
    process.env.SPEICHER_DATABASE_AUTH = 'managed_identity';
    process.env.SPEICHER_DATABASE_CLIENT_ID = 'client-123';
    const { url, credentialFor, seen } = fakeEntra();
    const sequelize = new Sequelize(url, {
      dialect: 'postgres',
      logging: false,
      hooks: databaseAuthHooks(credentialFor),
    });
    try {
      await expect(sequelize.authenticate()).resolves.toBeUndefined();
    } finally {
      await sequelize.close();
    }
    expect(seen.config).toEqual({ kind: 'managed_identity', client_id: 'client-123' });
    expect(seen.scopes).toEqual([POSTGRES_ENTRA_SCOPE]);
  });

  it('uses the URL password and no credential by default', async () => {
    delete process.env.SPEICHER_DATABASE_AUTH;
    const { url, credentialFor, seen } = fakeEntra();
    expect(databaseAuthHooks(credentialFor)).toEqual({});
    expect(seen.config).toBeUndefined();

    const sequelize = new Sequelize(url, { dialect: 'postgres', logging: false });
    try {
      // 28P01: invalid_password
      await expect(sequelize.authenticate()).rejects.toMatchObject({
        original: { code: '28P01' },
      });
    } finally {
      await sequelize.close();
    }
  });
});
