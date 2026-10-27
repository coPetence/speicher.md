import { listForges, listRepos } from '../../common/inspect';
import { relativeTime } from '../../common/time';
import { tenancy } from '../../db/tenancy';
import { Command, UsageError } from '../command-types';
import { createOutputFormat } from '../format';
import { formatTable } from '../table';

export function parseList(name: string, argv: string[]): void {
  const [action, ...commandArguments] = argv;
  if (action !== 'list') {
    const received = action === undefined ? 'no action' : JSON.stringify(action);
    throw new UsageError(
      'usage.unknown-action',
      `${name}: Expected \`list\`, got ${received}. Run \`speicher ${name} list\`.`,
    );
  }
  if (commandArguments.length > 0) {
    throw new UsageError(
      'usage.argument-count',
      `${name} list: No arguments allowed; got ${commandArguments.length}.`,
    );
  }
}

export const reposCommand: Command = {
  summary: 'List registered repositories.',
  args: 'list',
  needsCurrentSchema: true,
  check: (argv) => parseList('repos', argv),
  run: async (argv) => {
    parseList('repos', argv);
    const tenant = await tenancy.defaultTenant();
    const rows = await listRepos(tenant.id);
    if (rows.length === 0) {
      process.stdout.write(
        'No repositories registered. Run `speicher sync-repo-list` to import them from your forges.\n',
      );
      return 0;
    }
    process.stdout.write(
      formatTable(
        [
          'Repository',
          'Forge',
          'Branch',
          'Status',
          'Commit',
          'Last run',
          '.speicher.yaml',
          'Installation',
        ],
        rows.map((row) => [
          `${row.namespace}/${row.slug}`,
          row.forge,
          row.branch,
          row.last_status,
          (row.last_sha ?? '—').slice(0, 8),
          row.last_run_at ? relativeTime(row.last_run_at) : 'never',
          row.has_config ? 'present' : 'missing',
          row.installation ?? '—',
        ]),
        createOutputFormat(process.stdout),
      ),
    );
    return 0;
  },
};

export const forgesCommand: Command = {
  summary: 'List configured forges.',
  args: 'list',
  needsCurrentSchema: true,
  check: (argv) => parseList('forges', argv),
  run: async (argv) => {
    parseList('forges', argv);
    const tenant = await tenancy.defaultTenant();
    const rows = await listForges(tenant.id);
    if (rows.length === 0) {
      process.stdout.write('No forges registered.\n');
      return 0;
    }
    process.stdout.write(
      formatTable(
        ['Forge', 'Type', 'Primary', 'Default repository owner', 'Repositories', 'Installations'],
        rows.map((row) => [
          row.key,
          row.type,
          row.is_primary ? 'yes' : 'no',
          row.default_repository_owner ?? '—',
          String(row.repos),
          String(row.installations),
        ]),
        createOutputFormat(process.stdout),
      ),
    );
    return 0;
  },
};
