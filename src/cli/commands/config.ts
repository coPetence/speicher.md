import { writeFileSync } from 'node:fs';

import { getConfigTextForTenant } from '../../config/loader';
import { inlineBrandImages } from '../../dashboard/configurator/config-form/brand-inline';
import { exportConfig } from '../../dashboard/configurator/config-form/export';
import { instanceHost } from '../../common/env';
import { tenancy } from '../../db/tenancy';
import { Command, UsageError } from '../command-types';

export interface ConfigExportArgs {
  withSecrets: boolean;
  /** Output path; null uses stdout */
  path: string | null;
}

export function parseConfig(argv: string[]): ConfigExportArgs {
  const action = argv[0];
  if (action !== 'export') {
    const received = action === undefined ? 'no action' : JSON.stringify(action);
    throw new UsageError(
      'usage.unknown-action',
      `config: Expected \`export\`; got ${received}. Usage: speicher config export [<path>] [--with-secrets]`,
    );
  }
  const parsed: ConfigExportArgs = { withSecrets: false, path: null };
  for (const arg of argv.slice(1)) {
    if (arg === '--with-secrets') {
      parsed.withSecrets = true;
    } else if (arg.startsWith('-')) {
      throw new UsageError(
        'usage.unknown-argument',
        `config export: Unknown option ${JSON.stringify(arg)}. Only --with-secrets is supported.`,
        arg,
      );
    } else if (parsed.path !== null) {
      throw new UsageError(
        'usage.argument-count',
        'config export: Too many paths. Provide at most one.',
      );
    } else {
      parsed.path = arg;
    }
  }
  return parsed;
}

export const configCommand: Command = {
  summary:
    'Export configuration to a new file or stdout. Existing files are not overwritten. Secrets become environment variable references unless --with-secrets is used.',
  args: 'export [<path>] [--with-secrets]',
  needsCurrentSchema: true,
  check: (argv) => void parseConfig(argv),
  run: async (argv) => {
    const { withSecrets, path } = parseConfig(argv);
    const tenant = await tenancy.defaultTenant();
    const currentConfig = await getConfigTextForTenant(tenant.id);

    if (currentConfig.yaml.trim() === '') {
      process.stderr.write(
        'No stored configuration. Open this instance in a browser and claim it to set it up.\n',
      );
      return 1;
    }

    const inlined = await inlineBrandImages(tenant.id, currentConfig.yaml);
    const exported = exportConfig(inlined, {
      withSecrets,
      host: instanceHost(),
      version: currentConfig.version,
    });

    const document = exported.yaml.endsWith('\n') ? exported.yaml : `${exported.yaml}\n`;
    if (path === null) {
      process.stdout.write(document);
      return 0;
    }

    try {
      writeFileSync(path, document, { flag: 'wx', mode: withSecrets ? 0o600 : 0o644 });
    } catch (err) {
      const reason =
        (err as NodeJS.ErrnoException).code === 'EEXIST'
          ? `${path} already exists. Choose another path or delete the existing file.`
          : `Cannot write configuration to ${path}: ${(err as Error).message}`;
      process.stderr.write(`${reason}\n`);
      return 1;
    }
    process.stdout.write(`Configuration saved to ${path}.\n`);
    return 0;
  },
};
