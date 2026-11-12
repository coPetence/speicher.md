import type { TokenCredential } from '@azure/identity';
import { Options, Sequelize } from 'sequelize';

import { AzureCredentialConfig, createAzureCredential } from '../common/azure-credential';
import { env } from '../common/env';
import { rootLogger } from '../common/logger';
import { entraPassword } from './entra-token';

export function databaseUrl(): string {
  return env('SPEICHER_DATABASE_URL');
}

let instance: Sequelize | null = null;

export function getSequelize(): Sequelize {
  if (instance) {
    return instance;
  }
  const log = rootLogger.child('db');
  instance = new Sequelize(databaseUrl(), {
    dialect: 'postgres',
    logging:
      env('SPEICHER_LOG_LEVEL') === 'debug' ? (sql: string) => log.debug('sql', { sql }) : false,
    pool: { max: env('SPEICHER_DB_POOL'), idle: 10_000 },
    define: { underscored: true, timestamps: false, freezeTableName: true },
    hooks: databaseAuthHooks(),
  });
  return instance;
}

/** Use Entra tokens instead of the URL password when configured */
export function databaseAuthHooks(
  credentialFor: (config: AzureCredentialConfig) => TokenCredential = createAzureCredential,
): Options['hooks'] {
  const kind = env('SPEICHER_DATABASE_AUTH');
  if (kind === 'password') return {};
  const config: AzureCredentialConfig = { kind, client_id: env('SPEICHER_DATABASE_CLIENT_ID') };
  const password = entraPassword(credentialFor(config), config);
  return {
    beforeConnect: async (connection) => {
      connection.password = await password();
    },
  };
}

export async function closeSequelize(): Promise<void> {
  if (!instance) return;
  await instance.close();
  instance = null;
}
