import type { AccessToken, TokenCredential } from '@azure/identity';

import { entraPassword, POSTGRES_ENTRA_SCOPE } from '../../src/db/entra-token';

const HOUR = 60 * 60_000;

function fakeCredential(tokens: (AccessToken | null | Error)[]) {
  const scopes: (string | string[])[] = [];
  const credential: TokenCredential = {
    getToken: async (scope) => {
      scopes.push(scope);
      const next = tokens.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    },
  };
  return { credential, scopes };
}

describe('entraPassword', () => {
  const config = { kind: 'managed_identity' as const, client_id: 'abc' };

  it('asks for a token scoped to Azure Database for PostgreSQL', async () => {
    const { credential, scopes } = fakeCredential([{ token: 't1', expiresOnTimestamp: HOUR }]);
    await expect(entraPassword(credential, config, () => 0)()).resolves.toBe('t1');
    expect(scopes).toEqual([POSTGRES_ENTRA_SCOPE]);
  });

  it('reuses a token until five minutes before it expires', async () => {
    let now = 0;
    const { credential, scopes } = fakeCredential([
      { token: 't1', expiresOnTimestamp: HOUR },
      { token: 't2', expiresOnTimestamp: 2 * HOUR },
    ]);
    const password = entraPassword(credential, config, () => now);

    await expect(password()).resolves.toBe('t1');
    now = HOUR - 5 * 60_000 - 1;
    await expect(password()).resolves.toBe('t1');
    now = HOUR - 5 * 60_000;
    await expect(password()).resolves.toBe('t2');
    expect(scopes).toHaveLength(2);
  });

  it('shares one request among connections opening together', async () => {
    const { credential, scopes } = fakeCredential([{ token: 't1', expiresOnTimestamp: HOUR }]);
    const password = entraPassword(credential, config, () => 0);
    await expect(Promise.all([password(), password(), password()])).resolves.toEqual([
      't1',
      't1',
      't1',
    ]);
    expect(scopes).toHaveLength(1);
  });

  it('names the identity when the credential fails, and tries again next time', async () => {
    const { credential } = fakeCredential([
      new Error('IMDS unreachable'),
      { token: 't1', expiresOnTimestamp: HOUR },
    ]);
    const password = entraPassword(credential, config, () => 0);
    await expect(password()).rejects.toFailWith('db.entra-token-unavailable', {
      identity: 'user-assigned managed identity abc',
      reason: 'IMDS unreachable',
    });
    await expect(password()).resolves.toBe('t1');
  });

  it('refuses a credential that returns no token', async () => {
    const { credential } = fakeCredential([null]);
    await expect(entraPassword(credential, config, () => 0)()).rejects.toFailWith(
      'db.entra-token-unavailable',
    );
  });
});
