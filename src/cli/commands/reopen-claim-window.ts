import { rootLogger } from '../../common/logger';
import { setup } from '../../dashboard/setup/setup.service';
import { tenancy } from '../../db/tenancy';
import { Command, UsageError } from '../command-types';

export function parseReopenClaimWindow(argv: string[]): void {
  if (argv.length > 0) {
    throw new UsageError(
      'usage.argument-count',
      `reopen-claim-window takes no arguments; received ${argv.length}.`,
    );
  }
}

export const reopenClaimWindowCommand: Command = {
  summary:
    'Reopen the claim window when no administrator is configured. If an existing administrator cannot sign in, use `speicher admin add` instead.',
  args: '',
  needsCurrentSchema: true,
  check: (argv) => parseReopenClaimWindow(argv),
  run: async (argv) => {
    const log = rootLogger.child('setup');
    parseReopenClaimWindow(argv);
    const tenant = await tenancy.defaultTenant();
    const { reopened, count } = await setup.reopen(tenant.id);
    if (!reopened) {
      process.stdout.write('Claim window is already open.\n');
      return 0;
    }
    // Log unexpected reopening as an error
    log.error('Setup claim window reopened', { reopens: count });
    process.stdout.write(
      'Claim window reopened. Open this instance in a browser, then run `speicher claim <code>` to approve that browser session.\n',
    );
    return 0;
  },
};
