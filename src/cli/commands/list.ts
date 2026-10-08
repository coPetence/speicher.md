import { listForges, listRepos } from '../../common/inspect';
import { relativeTime } from '../../common/time';
import { tenancy } from '../../db/tenancy';
import { Command, UsageError } from '../command-types';
import { createOutputFormat } from '../format';
import { formatTable } from '../table';

export function parseList(name: string, argv: string[]): void {
  const [action, ...commandArguments] = argv;
  if (action !== 'list') {
    const received = action === undefined ? 'nothing' : JSON.stringify(action);
    throw new UsageError(
      `${name}: Expected the action \`list\`, but received ${received}. To see the registered ${name}, run \`speicher ${name} list\`.`,
    );
  }
  if (commandArguments.length > 0) {
    throw new UsageError(
      `${name} list: Expected no arguments after \`list\`, but received ${commandArguments.length}.`,
    );
  }
}

export const reposCommand: Command = {
  summary: 'List every repository registered on this instance.',
  args: 'list',
  needsCurrentSchema: true,
  check: (argv) => parseList('repos', argv),
  run: async (argv) => {
    parseList('repos', argv);
    const tenant = await tenancy.defaultTenant();
    const rows = await listRepos(tenant.id);
    if (rows.length === 0) {
      process.stdout.write(
        'This instance has no repositories registered yet. To register the repositories your forges hold, run `speicher sync-repo-list`.\n',
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
  summary: 'List every content source configured on this instance.',
  args: 'list',
  needsCurrentSchema: true,
  check: (argv) => parseList('forges', argv),
  run: async (argv) => {
    parseList('forges', argv);
    const tenant = await tenancy.defaultTenant();
    const rows = await listForges(tenant.id);
    if (rows.length === 0) {
      process.stdout.write('This instance has no forges registered yet.\n');
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
