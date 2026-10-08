/*
 * Run the app against test/fixtures
 *
 *   npm run dev
 *   npm run dev -- --watch
 */
import { watch } from 'node:fs';
import { join } from 'node:path';

import { buildClient } from './build-client';
import { ROOT, devEnv, runFromSource } from './dev-env';

const watchMode = process.argv.includes('--watch');

const shared = devEnv();
const env = {
  ...shared,
  SPEICHER_DEV_LOGIN: 'true',
  SPEICHER_INSECURE_COOKIES: 'true', // Local development has no TLS
  PORT: shared.PORT ?? '3000',
};

function rebuild(): boolean {
  try {
    buildClient();
    return true;
  } catch (err) {
    process.stderr.write(`client build failed: ${(err as Error).message}\n`);
    return false;
  }
}

if (!rebuild()) process.exit(1);

runFromSource('src/main.ts', env);

if (watchMode) {
  const dirs = [
    'src/global-ui/theme',
    'src/global-ui/components',
    'src/global-ui/client-side-islands',
  ];
  let pending: NodeJS.Timeout | undefined;
  for (const dir of dirs) {
    watch(join(ROOT, dir), { recursive: true }, () => {
      clearTimeout(pending);

      pending = setTimeout(() => {
        process.stdout.write('client changed, rebuilding\n');
        rebuild();
      }, 120);
    });
  }
  process.stdout.write(`watching ${dirs.join(', ')}\n`);
}
