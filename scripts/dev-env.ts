import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export const ROOT = join(__dirname, '..');
const ENV_FILE = join(ROOT, 'var/dev.env');

function throwawayKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

export function devEnv(): NodeJS.ProcessEnv {
  const fromFile = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, 'utf8')) : {};
  const given: NodeJS.ProcessEnv = { ...fromFile, ...process.env };
  return {
    ...given,
    SPEICHER_CONFIG: given.SPEICHER_CONFIG ?? join(ROOT, 'test/fixtures/instance.yaml'),
    SPEICHER_ASSET_PATH: given.SPEICHER_ASSET_PATH ?? join(ROOT, 'var/assets'),
    SPEICHER_LOG_LEVEL: given.SPEICHER_LOG_LEVEL ?? 'info',
    SPEICHER_LOG_FORMAT: given.SPEICHER_LOG_FORMAT ?? 'pretty',
    TEST_ENTRA_CLIENT_ID: given.TEST_ENTRA_CLIENT_ID ?? 'dev-client-id',
    TEST_ENTRA_CLIENT_SECRET: given.TEST_ENTRA_CLIENT_SECRET ?? 'dev-client-secret',
    TEST_GH_APP_ID: given.TEST_GH_APP_ID ?? '424242',
    TEST_GH_PRIVATE_KEY: given.TEST_GH_PRIVATE_KEY ?? throwawayKey(),
    TEST_GH_WEBHOOK_SECRET: given.TEST_GH_WEBHOOK_SECRET ?? 'dev-webhook-secret',
  };
}

export function runFromSource(entry: string, env: NodeJS.ProcessEnv): void {
  const child = spawn('npx', ['ts-node', '-T', join(ROOT, entry)], {
    stdio: 'inherit',
    cwd: ROOT,
    env,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => child.kill(signal));
  }
}
