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
  '--kind': `The kinds are ${JOB_KINDS.join(', ')}.`,
  '--status': `The statuses are ${JOB_STATUSES.join(', ')}.`,
  '--limit': 'The limit is a whole number between 1 and 500.',
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
      `jobs: Expected the action \`list\` or \`retry\`, but received ${received}. To see the queued jobs, run \`speicher jobs list\`, or to put a dead job back on the queue, run \`speicher jobs retry <id>\`.`,
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
          `jobs ${parsed.action}: Expected a value after ${arg}, but received nothing. ${OPTION_VALUES[arg]}`,
        );
      }
      i += 1;
      if (arg === '--kind') {
        if (!isJobKind(value)) {
          throw new UsageError(
            `jobs ${parsed.action}: ${JSON.stringify(value)} is an unknown kind. ${OPTION_VALUES['--kind']}`,
          );
        }
        parsed.kind = value;
      } else if (arg === '--status') {
        if (!isJobStatus(value)) {
          throw new UsageError(
            `jobs ${parsed.action}: ${JSON.stringify(value)} is an unknown status. ${OPTION_VALUES['--status']}`,
          );
        }
        parsed.status = value;
      } else {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
          throw new UsageError(
            `jobs ${parsed.action}: ${JSON.stringify(value)} is not a valid limit. ${OPTION_VALUES['--limit']}`,
          );
        }
        parsed.limit = limit;
      }
      continue;
    }
    if (arg.startsWith('--')) {
      throw new UsageError(
        `jobs ${action}: ${JSON.stringify(arg)} is an unknown option. The options of \`jobs ${action}\` are ${ACTION_OPTIONS[action]}.`,
      );
    }
    if (parsed.id !== null) {
      throw new UsageError(
        `jobs ${action}: Expected one job id, but received more than one. To retry every dead job, run \`speicher jobs retry --all\`, or to retry every dead job of one kind, run \`speicher jobs retry --kind <kind>\`.`,
      );
    }

    parsed.id = arg;
  }

  if (parsed.action === 'list') {
    if (parsed.id || parsed.all || parsed.kind) {
      throw new UsageError(
        `jobs list: The options of \`jobs list\` are ${ACTION_OPTIONS.list}. To put a dead job back on the queue, run \`speicher jobs retry <id>\`.`,
      );
    }
    return parsed;
  }
  // retry needs at least id, --all or --kind
  if (!parsed.id && !parsed.all && !parsed.kind) {
    throw new UsageError(
      'jobs retry: Expected a job id, --all or --kind, but received none of them. To find out which jobs are dead, run `speicher jobs list --status dead`.',
    );
  }
  if (parsed.id && (parsed.all || parsed.kind)) {
    throw new UsageError(
      'jobs retry: A job id cannot be combined with --all or --kind. The id already specifies the job that should be retried.',
    );
  }
  if (parsed.status) {
    throw new UsageError(
      'jobs retry: The option --status cannot be used with `jobs retry`. Only dead jobs can be retried.',
    );
  }
  return parsed;
}

export const jobsCommand: Command = {
  summary:
    'Lists the jobs in the queue or puts dead jobs back on it. To see the queued jobs, run `speicher jobs list`. To put a dead job back on the queue, run `speicher jobs retry <id>`.',
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
        process.stdout.write('The queue holds no jobs.\n');
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
        'No dead job matched. To find out which jobs are dead, run `speicher jobs list --status dead`.\n',
      );
      return 1;
    }
    log.info('dead jobs retried', { count: retried, kind: parsed.kind ?? null });
    process.stdout.write(`Put ${retried} job(s) back on the queue.\n`);
    return 0;
  },
};
