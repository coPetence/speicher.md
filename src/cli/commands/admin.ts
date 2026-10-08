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
      `admin: Expected the action \`add\`, but received ${received}. To add an administrator, run \`speicher admin add --provider <id> --email <address>\`.`,
    );
  }

  const grant: AdminGrant = {};
  const commandArguments = argv.slice(1);
  for (let i = 0; i < commandArguments.length; i += 2) {
    const flag = commandArguments[i];
    const value = commandArguments[i + 1];
    if (value === undefined) {
      throw new UsageError(`admin add: Expected a value after ${flag}, but received nothing.`);
    }
    if (flag === '--provider') grant.provider = value;
    else if (flag === '--subject') grant.subject = value;
    else if (flag === '--email') grant.email = value;
    else if (flag === '--note') grant.note = value;
    else {
      throw new UsageError(
        `admin add: ${JSON.stringify(flag)} is an unknown argument. The options are --provider, --subject, --email and --note.`,
      );
    }
  }

  if (!grant.subject && !grant.email) {
    throw new UsageError(
      'admin add: Expected --email or --subject, but received neither. Use --email to identify the person by their email address, or --subject with --note to identify them by the subject claim of their identity provider.',
    );
  }

  if (grant.subject && grant.email) {
    throw new UsageError(
      'admin add: --subject and --email cannot be combined, because each one identifies the person on its own.',
    );
  }

  // Subject must identify the person for the audit log
  if (grant.subject && !grant.note) {
    throw new UsageError(
      'admin add: --subject requires --note to map the subject to a person in the audit log.',
    );
  }

  return grant;
}

export const adminCommand: Command = {
  summary:
    'Adds an administrator to the stored configuration, identified by an email address or by the subject claim of their identity provider. This requires a stored configuration. If no configuration is stored yet, open the instance in a browser and claim it there instead.',
  args: 'add (--email <address> | --subject <id> --note <text>) [--provider <id>]',
  needsCurrentSchema: true,
  check: (argv) => void parseAdmin(argv),
  run: async (argv) => {
    const log = rootLogger.child('setup');
    const grant = parseAdmin(argv);
    const tenant = await tenancy.defaultTenant();

    const latestConfigVersion = await getNewestConfigVersion(tenant.id);
    if (!latestConfigVersion) {
      // No stored config yet means the owner must claim via browser
      process.stderr.write(
        'This instance has no stored configuration yet. To set it up, open it in a browser and claim it.\n',
      );
      return 1;
    }

    const saved = await addAdministrator(tenant.id, grant, {
      origin: 'admin',
      appliedBy: 'cli:admin add',
    });
    log.info('administrator added', {
      version: saved.version,
      provider: grant.provider ?? null,
    });
    process.stdout.write(
      `The administrator was added, and the configuration was updated. The change applies to the next request without a restart.\n`,
    );
    return 0;
  },
};
