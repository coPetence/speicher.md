import { rootLogger } from '../../common/logger';
import { relativeTime } from '../../common/time';
import { tenancy } from '../../db/tenancy';
import type { JobKind, JobStatus } from '../../jobs/queue';
import { JOB_KINDS, JOB_STATUSES, JobQueue, isJobKind, isJobStatus } from '../../jobs/queue';
import { Command, UsageError } from '../command-types';
import { createOutputFormat } from '../format';
import { formatTable } from '../table';

export interface JobsArgs {
  action: 'list' | 'retry';
  id: string | null;
  kind: JobKind | null;
  all: boolean;
  status: JobStatus | null;
  limit: number;
}

const OPTION_VALUES: Record<string, string> = {
  '--kind': `Valid kinds: ${JOB_KINDS.join(', ')}.`,
  '--status': `Valid statuses: ${JOB_STATUSES.join(', ')}.`,
  '--limit': 'Use a whole number from 1 to 500.',
};

const ACTION_OPTIONS: Record<JobsArgs['action'], string> = {
  list: '--status and --limit',
  retry: '--all and --kind',
};

export function parseJobs(argv: string[]): JobsArgs {
  const action = argv[0];
  if (action !== 'list' && action !== 'retry') {
    const received = action === undefined ? 'nothing' : JSON.stringify(action);
    throw new UsageError(
      'usage.unknown-action',
      `jobs: Invalid action: ${received}. Use \`speicher jobs list\` or \`speicher jobs retry <id>\`.`,
    );
  }

  const parsed: JobsArgs = {
    action,
    id: null,
    kind: null,
    all: false,
    status: null,
    limit: 50,
  };

  const commandArguments = argv.slice(1);
  for (let i = 0; i < commandArguments.length; i += 1) {
    const arg = commandArguments[i];

    if (arg === '--all') {
      parsed.all = true;
      continue;
    }

    if (arg === '--kind' || arg === '--status' || arg === '--limit') {
      const value = commandArguments[i + 1];
      if (value === undefined) {
        throw new UsageError(
          'usage.missing-value',
          `jobs ${parsed.action}: Missing value for ${arg}. ${OPTION_VALUES[arg]}`,
          arg,
        );
      }
      i += 1;
      if (arg === '--kind') {
        if (!isJobKind(value)) {
          throw new UsageError(
            'usage.invalid-value',
            `jobs ${parsed.action}: Unknown kind: ${JSON.stringify(value)}. ${OPTION_VALUES['--kind']}`,
            value,
          );
        }
        parsed.kind = value;
      } else if (arg === '--status') {
        if (!isJobStatus(value)) {
          throw new UsageError(
            'usage.invalid-value',
            `jobs ${parsed.action}: Unknown status: ${JSON.stringify(value)}. ${OPTION_VALUES['--status']}`,
            value,
          );
        }
        parsed.status = value;
      } else {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
          throw new UsageError(
            'usage.invalid-value',
            `jobs ${parsed.action}: Invalid limit: ${JSON.stringify(value)}. ${OPTION_VALUES['--limit']}`,
            value,
          );
        }
        parsed.limit = limit;
      }
      continue;
    }
    if (arg.startsWith('--')) {
      throw new UsageError(
        'usage.unknown-argument',
        `jobs ${action}: Unknown option: ${JSON.stringify(arg)}. Valid options: ${ACTION_OPTIONS[action]}.`,
        arg,
      );
    }
    if (parsed.id !== null) {
      throw new UsageError(
        'usage.argument-count',
        `jobs ${action}: Too many job IDs. Pass one ID, or use \`speicher jobs retry --all\` or \`speicher jobs retry --kind <kind>\`.`,
      );
    }

    parsed.id = arg;
  }

  if (parsed.action === 'list') {
    if (parsed.id || parsed.all || parsed.kind) {
      throw new UsageError(
        'usage.conflicting-options',
        `jobs list: Job IDs, --all and --kind are not supported. Valid options: ${ACTION_OPTIONS.list}. Use \`speicher jobs retry\` to retry jobs.`,
      );
    }
    return parsed;
  }
  // Retry requires a job ID, --all or --kind
  if (!parsed.id && !parsed.all && !parsed.kind) {
    throw new UsageError(
      'usage.missing-option',
      'jobs retry: Missing job selection. Pass a job ID, --all or --kind <kind>.',
    );
  }
  if (parsed.id && (parsed.all || parsed.kind)) {
    throw new UsageError(
      'usage.conflicting-options',
      'jobs retry: Cannot combine a job ID with --all or --kind. Use the ID alone.',
    );
  }
  if (parsed.status) {
    throw new UsageError(
      'usage.conflicting-options',
      'jobs retry: --status is not supported. Only dead jobs can be retried.',
      '--status',
    );
  }
  return parsed;
}

export const jobsCommand: Command = {
  summary: 'List queued jobs or retry dead jobs.',
  args: 'list [--status <status>] [--limit <number>] | retry (<id> | --all | --kind <kind>)',
  needsCurrentSchema: true,
  check: (argv) => void parseJobs(argv),
  run: async (argv) => {
    const log = rootLogger.child('jobs');
    const parsed = parseJobs(argv);
    const tenant = await tenancy.defaultTenant();
    const queue = new JobQueue();

    if (parsed.action === 'list') {
      const rows = await queue.list({
        tenantId: tenant.id,
        status: parsed.status ?? undefined,
        limit: parsed.limit,
      });
      if (rows.length === 0) {
        process.stdout.write('No matching jobs.\n');
        return 0;
      }
      process.stdout.write(
        formatTable(
          ['Id', 'Kind', 'Status', 'Attempts', 'Updated', 'Payload', 'Last error'],
          rows.map((row) => [
            row.id,
            row.kind,
            row.status,
            `${row.attempts}/${row.max_attempts}`,
            relativeTime(row.updated_at),
            JSON.stringify(row.payload),
            row.last_error?.replace(/\s*\n\s*/g, ' ') ?? '—',
          ]),
          createOutputFormat(process.stdout),
        ),
      );
      return 0;
    }

    const retried = await queue.retryDead({
      tenantId: tenant.id,
      ids: parsed.id ? [parsed.id] : undefined,
      kind: parsed.kind ?? undefined,
    });
    if (retried === 0) {
      process.stderr.write(
        'No matching dead jobs. List dead jobs with `speicher jobs list --status dead`.\n',
      );
      return 1;
    }
    log.info('dead jobs retried', { count: retried, kind: parsed.kind ?? null });
    process.stdout.write(`Requeued ${retried} job(s).\n`);
    return 0;
  },
};
