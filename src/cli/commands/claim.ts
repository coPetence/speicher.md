import { rootLogger } from '../../common/logger';
import { relativeTime } from '../../common/time';
import { normalizeClaimCode } from '../../dashboard/setup/claim-code';
import { setup } from '../../dashboard/setup/setup.service';
import { tenancy } from '../../db/tenancy';
import { Command, UsageError } from '../command-types';

export function parseClaim(argv: string[]): { code: string | null } {
  if (argv.length === 0) return { code: null };
  if (argv.length > 1) {
    throw new UsageError(`claim: Expected one argument, but received ${argv.length}.`);
  }
  const code = normalizeClaimCode(argv[0]);
  if (!code) {
    throw new UsageError(
      `claim: ${JSON.stringify(argv[0])} is not a claim code. Check the browser's claim page to get a valid code.`,
    );
  }
  return { code };
}

export const claimCommand: Command = {
  summary:
    'Approves a browser that is waiting to set up this instance. If you run the command without a code, it lists the browsers that are waiting. A code expires after an hour.',
  args: '[<code>]',
  needsCurrentSchema: true,
  check: (argv) => void parseClaim(argv),
  run: async (argv) => {
    const log = rootLogger.child('setup');
    const { code } = parseClaim(argv);
    const tenant = await tenancy.defaultTenant();

    if (code === null) {
      const pending = await setup.pending(tenant.id);
      if (pending.length === 0) {
        process.stdout.write('No browser is waiting to claim this instance.\n');
        return 0;
      }
      process.stdout.write('Waiting to claim this instance:\n\n');
      for (const claim of pending) {
        const state = claim.approved_at ? ' (approved, not yet collected)' : '';
        process.stdout.write(
          `  ${claim.code}  from ${claim.origin}  ${relativeTime(claim.created_at)}${state}\n`,
        );
      }
      process.stdout.write('\nApprove one with: speicher claim <code>\n');
      return 0;
    }

    const result = await setup.approve(tenant.id, code);
    if (result.status === 'approved') {
      log.info('setup claim approved', { code, origin: result.claim.origin });
      process.stdout.write(
        `Approved ${code}, requested by ${result.claim.origin} ` +
          `${relativeTime(result.claim.created_at)}. That browser is now signed in.\n`,
      );
      return 0;
    }
    if (result.status === 'already-approved') {
      process.stdout.write(`${code} was already approved. That browser can sign in.\n`);
      return 0;
    }

    if (result.status === 'closed') {
      // Claim window closes permanently once an administrator signs in
      process.stderr.write(
        'This instance already has an administrator, so it can no longer be claimed. To find out who the administrators are, run `speicher config export`. To add another administrator, run `speicher admin add --provider <id> --email <address>`.\n',
      );
      return 1;
    }
    process.stderr.write(
      `No browser is waiting with the code ${code}. Codes expire after an hour — ` +
        'reload the page to take a new one, and run `speicher claim` to list them.\n',
    );
    return 1;
  },
};
