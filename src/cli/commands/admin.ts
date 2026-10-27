import { rootLogger } from '../../common/logger';
import { getNewestConfigVersion } from '../../config/loader';
import { AdminGrant, addAdministrator } from '../../dashboard/setup/first-admin';
import { tenancy } from '../../db/tenancy';
import { Command, UsageError } from '../command-types';

export function parseAdmin(argv: string[]): AdminGrant {
  const action = argv[0];
  if (action !== 'add') {
    const received = action === undefined ? 'nothing' : JSON.stringify(action);
    throw new UsageError(
      'usage.unknown-action',
      `admin: Expected \`add\`; got ${received}. Usage: \`speicher admin add --email <address> [--provider <id>]\`.`,
    );
  }

  const grant: AdminGrant = {};
  const commandArguments = argv.slice(1);
  for (let i = 0; i < commandArguments.length; i += 2) {
    const flag = commandArguments[i];
    const value = commandArguments[i + 1];
    if (value === undefined) {
      throw new UsageError('usage.missing-value', `admin add: Missing value for ${flag}.`, flag);
    }
    if (flag === '--provider') grant.provider = value;
    else if (flag === '--subject') grant.subject = value;
    else if (flag === '--email') grant.email = value;
    else if (flag === '--note') grant.note = value;
    else {
      throw new UsageError(
        'usage.unknown-argument',
        `admin add: Unknown argument ${JSON.stringify(flag)}. Valid options: --provider, --subject, --email, --note.`,
        flag,
      );
    }
  }

  if (!grant.subject && !grant.email) {
    throw new UsageError(
      'usage.missing-option',
      'admin add: Specify --email <address> or --subject <id> --note <text>.',
    );
  }

  if (grant.subject && grant.email) {
    throw new UsageError(
      'usage.conflicting-options',
      'admin add: Use either --subject or --email, not both.',
    );
  }

  // Require a note to identify the subject in the audit log
  if (grant.subject && !grant.note) {
    throw new UsageError(
      'usage.missing-option',
      'admin add: --subject requires --note to identify the person in the audit log.',
      '--note',
    );
  }

  return grant;
}

export const adminCommand: Command = {
  summary:
    'Add an administrator by email or identity-provider subject ID. Requires a stored configuration; otherwise, open the instance in a browser to claim it.',
  args: 'add (--email <address> | --subject <id> --note <text>) [--provider <id>]',
  needsCurrentSchema: true,
  check: (argv) => void parseAdmin(argv),
  run: async (argv) => {
    const log = rootLogger.child('setup');
    const grant = parseAdmin(argv);
    const tenant = await tenancy.defaultTenant();

    const latestConfigVersion = await getNewestConfigVersion(tenant.id);
    if (!latestConfigVersion) {
      // Unconfigured instances must be claimed in the browser
      process.stderr.write(
        'No stored configuration. Open this instance in a browser to claim it first.\n',
      );
      return 1;
    }

    const saved = await addAdministrator(tenant.id, grant, {
      origin: 'admin',
      appliedBy: 'cli:admin add',
    });
    log.info('Administrator added', {
      version: saved.version,
      provider: grant.provider ?? null,
    });
    process.stdout.write(
      `Administrator added. Configuration updated; effective on the next request. No restart needed.\n`,
    );
    return 0;
  },
};
