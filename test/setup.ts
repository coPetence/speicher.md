import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { testDatabaseUrl } from './helpers/test-database';

process.env.SPEICHER_CONFIG ??= resolve(__dirname, 'fixtures/instance.yaml');
process.env.TEST_ENTRA_CLIENT_ID ??= 'test-entra-client';
process.env.TEST_ENTRA_CLIENT_SECRET ??= 'test-entra-secret';
process.env.TEST_GH_APP_ID ??= '424242';
process.env.TEST_GH_DIRECTORY_APP_ID ??= '434343';
process.env.TEST_GH_PRIVATE_KEY ??= generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
process.env.TEST_GH_WEBHOOK_SECRET ??= 'test-webhook-secret';
process.env.SPEICHER_LOG_LEVEL ??= 'error';
process.env.SPEICHER_DATABASE_URL ??= testDatabaseUrl();
process.env.SPEICHER_MIRROR_ROOT ??= mkdtempSync(join(tmpdir(), 'speicher-mirrors-'));

process.env.SPEICHER_ANON_RATE_LIMIT ??= '0';

process.env.SPEICHER_PUBLIC_MAX_AGE ??= '0';

process.env.SPEICHER_CONFIG_POLL ??= '0';

jest.setTimeout(60_000);
