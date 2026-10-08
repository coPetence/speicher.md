import { writeFileSync } from 'node:fs';

import { getConfigTextForTenant } from '../../config/loader';
import { exportConfig } from '../../dashboard/configurator/config-form/export';
import { instanceHost } from '../../common/env';
import { tenancy } from '../../db/tenancy';
import { Command, UsageError } from '../command-types';

export interface ConfigExportArgs {
  withSecrets: boolean;
  /** Where to write the export; null prints it to stdout */
  path: string | null;
}

export function parseConfig(argv: string[]): ConfigExportArgs {
  const action = argv[0];
  if (action !== 'export') {
    const received = action === undefined ? 'nothing' : JSON.stringify(action);
    throw new UsageError(
      `config: Expected the action \`export\`, but received ${received}. To write the configuration to a file, run \`speicher config export config.yaml\`.`,
    );
  }
  const parsed: ConfigExportArgs = { withSecrets: false, path: null };
  for (const arg of argv.slice(1)) {
    if (arg === '--with-secrets') {
      parsed.withSecrets = true;
    } else if (arg.startsWith('-')) {
      throw new UsageError(
        `config export: ${JSON.stringify(arg)} is an unknown argument. The only option is --with-secrets.`,
      );
    } else if (parsed.path !== null) {
      throw new UsageError('config export: Expected one path, but received more than one.');
    } else {
      parsed.path = arg;
    }
  }
  return parsed;
}

export const configCommand: Command = {
  summary:
    'Writes the instance configuration to the given file, or to stdout if you give no path. An existing file is never overwritten. Secrets stored in the configuration are replaced by environment variable references, unless you add --with-secrets.',
  args: 'export [<path>] [--with-secrets]',
  needsCurrentSchema: true,
  check: (argv) => void parseConfig(argv),
  run: async (argv) => {
    const { withSecrets, path } = parseConfig(argv);
    const tenant = await tenancy.defaultTenant();
    const currentConfig = await getConfigTextForTenant(tenant.id);

    if (currentConfig.yaml.trim() === '') {
      process.stderr.write(
        'This instance has no stored configuration yet. To set it up, open it in a browser and claim it.\n',
      );
      return 1;
    }

    const exported = exportConfig(currentConfig.yaml, {
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
          ? `${path} already exists. Delete the file or choose another path.`
          : `The configuration could not be written to ${path}: ${(err as Error).message}`;
      process.stderr.write(`${reason}\n`);
      return 1;
    }
    process.stdout.write(`The configuration was written to ${path}.\n`);
    return 0;
  },
};
