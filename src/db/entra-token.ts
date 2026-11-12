/** Entra tokens as Azure PostgreSQL passwords */

import type { AccessToken, TokenCredential } from '@azure/identity';

import { AzureCredentialConfig, describeAzureCredential } from '../common/azure-credential';
import { CodedError } from '../common/errors';

/** Azure PostgreSQL token scope */
export const POSTGRES_ENTRA_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

/** Token retrieval failed for the specified identity */
export class EntraTokenError extends CodedError<'db.entra-token-unavailable'> {
  constructor(
    readonly identity: string,
    readonly reason: string,
  ) {
    super(
      'db.entra-token-unavailable',
      `Could not get an Entra token for PostgreSQL as ${identity}: ${reason}`,
    );
  }
}

/** Refresh tokens five minutes before expiry */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Supplies tokens for new connections, caching until near expiry
 * Concurrent calls share one token request
 */
export function entraPassword(
  credential: TokenCredential,
  config: AzureCredentialConfig,
  now: () => number = Date.now,
): () => Promise<string> {
  let cached: AccessToken | null = null;
  let pending: Promise<AccessToken> | null = null;

  return async () => {
    if (cached && cached.expiresOnTimestamp - REFRESH_MARGIN_MS > now()) return cached.token;
    pending ??= fetchToken(credential, config).finally(() => {
      pending = null;
    });
    cached = await pending;
    return cached.token;
  };
}

async function fetchToken(
  credential: TokenCredential,
  config: AzureCredentialConfig,
): Promise<AccessToken> {
  const identity = describeAzureCredential(config);
  let token: AccessToken | null;
  try {
    token = await credential.getToken(POSTGRES_ENTRA_SCOPE);
  } catch (error) {
    throw new EntraTokenError(identity, error instanceof Error ? error.message : String(error));
  }
  if (!token) throw new EntraTokenError(identity, 'the credential returned none');
  return token;
}
