import { rootLogger } from '../../common/logger';
import { setup } from '../../dashboard/setup/setup.service';
import { tenancy } from '../../db/tenancy';
import { Command, UsageError } from '../command-types';

export function parseReopenClaimWindow(argv: string[]): void {
  if (argv.length > 0) {
    throw new UsageError(
      `reopen-claim-window: Expected no arguments, but received ${argv.length}.`,
    );
  }
}

export const reopenClaimWindowCommand: Command = {
  summary:
    'Reopens the claim window. This could be needed if the claim window was closed and no administrator is configured, for example after a configuration rollback. If an administrator is still configured but cannot sign in, run `speicher admin add` instead.',
  args: '',
  needsCurrentSchema: true,
  check: (argv) => parseReopenClaimWindow(argv),
  run: async (argv) => {
    const log = rootLogger.child('setup');
    parseReopenClaimWindow(argv);
    const tenant = await tenancy.defaultTenant();
    const { reopened, count } = await setup.reopen(tenant.id);
    if (!reopened) {
      process.stdout.write('The claim window is already open.\n');
      return 0;
    }
    // Reopening after it was closed is abnormal; log at error level
    log.error('the setup claim window was reopened', { reopens: count });
    process.stdout.write(
      'The claim window is open again. To approve a browser session, open this instance in it and run `speicher claim <code>`.\n',
    );
    return 0;
  },
};
