import { rootLogger } from '../../common/logger';
import { relativeTime } from '../../common/time';
import { normalizeClaimCode } from '../../dashboard/setup/claim-code';
import { setup } from '../../dashboard/setup/setup.service';
import { tenancy } from '../../db/tenancy';
import { Command, UsageError } from '../command-types';

export function parseClaim(argv: string[]): { code: string | null } {
  if (argv.length === 0) return { code: null };
  if (argv.length > 1) {
    throw new UsageError(
      'usage.argument-count',
      `claim: Expected at most one code; got ${argv.length} arguments.`,
    );
  }
  const code = normalizeClaimCode(argv[0]);
  if (!code) {
    throw new UsageError(
      'usage.invalid-value',
      `claim: Invalid code ${JSON.stringify(argv[0])}. Copy the code from your browser's claim page.`,
      argv[0],
    );
  }
  return { code };
}

export const claimCommand: Command = {
  summary:
    'Approve a browser to set up this instance, or omit the code to list waiting browsers. Codes expire after one hour.',
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
        process.stdout.write('No browsers are waiting for approval.\n');
        return 0;
      }
      process.stdout.write('Browsers awaiting setup:\n\n');
      for (const claim of pending) {
        const state = claim.approved_at ? ' (approved; waiting for browser)' : '';
        process.stdout.write(
          `  ${claim.code}  from ${claim.origin}  ${relativeTime(claim.created_at)}${state}\n`,
        );
      }
      process.stdout.write('\nTo approve: speicher claim <code>\n');
      return 0;
    }

    const result = await setup.approve(tenant.id, code);
    if (result.status === 'approved') {
      log.info('setup claim approved', { code, origin: result.claim.origin });
      process.stdout.write(
        `Approved ${code} from ${result.claim.origin} ` +
          `(requested ${relativeTime(result.claim.created_at)}). The browser can now sign in.\n`,
      );
      return 0;
    }
    if (result.status === 'already-approved') {
      process.stdout.write(`${code} is already approved. The browser can sign in.\n`);
      return 0;
    }

    if (result.status === 'closed') {
      // First admin sign-in permanently closes claiming
      process.stderr.write(
        'Cannot claim: this instance already has an administrator.\n' +
          'List administrators: speicher config export\n' +
          'Add an administrator: speicher admin add --provider <id> --email <address>\n',
      );
      return 1;
    }
    process.stderr.write(
      `Code ${code} not found. Codes expire after one hour.\n` +
        'Reload the browser claim page for a new code, or run `speicher claim` to list waiting browsers.\n',
    );
    return 1;
  },
};
