import { Sequelize } from 'sequelize';

import { env } from '../common/env';
import { rootLogger } from '../common/logger';

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
  });
  return instance;
}

export async function closeSequelize(): Promise<void> {
  if (!instance) return;
  await instance.close();
  instance = null;
}
