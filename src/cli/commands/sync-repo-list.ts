import { rootLogger } from '../../common/logger';
import { ConfigService } from '../../config/config.service';
import { loadActiveInstanceConfig } from '../../config/loader';
import { tenancy } from '../../db/tenancy';
import { JobQueue } from '../../jobs/queue';
import { Command, UsageError } from '../command-types';

export function parseSyncRepoList(argv: string[]): { forgeKey: string | null } {
  if (argv.length > 1)
    throw new UsageError(`sync-repo-list: Expected one argument, but received ${argv.length}.`);
  const forgeKey = argv[0];
  if (forgeKey !== undefined && forgeKey.startsWith('-')) {
    throw new UsageError(`sync-repo-list: ${JSON.stringify(forgeKey)} is an unknown argument.`);
  }
  return { forgeKey: forgeKey ?? null };
}

export const syncRepoListCommand: Command = {
  summary:
    'Fetches the list of repositories from the provided forge or all configured forges if none was provided. It then updates the list of repositories in the database to match the fetched list. New repositories are added, renamed ones are updated, and repositories that are no longer present are removed. This command only queues the job, it does not await its completion.',
  args: '[<forge>]',
  needsCurrentSchema: true,
  check: (argv) => void parseSyncRepoList(argv),
  run: async (argv) => {
    const log = rootLogger.child('sync-repo-list');
    const { forgeKey } = parseSyncRepoList(argv);
    const tenant = await tenancy.defaultTenant();
    const config = new ConfigService(await loadActiveInstanceConfig());

    if (forgeKey !== null && !config.forgeIds.includes(forgeKey)) {
      process.stderr.write(
        `No forge called ${JSON.stringify(forgeKey)} is configured. To find out which forges are configured, run \`speicher forges list\`.\n`,
      );
      return 1;
    }

    if (config.forgeIds.length === 0) {
      process.stderr.write('This instance has no content source configured.\n');
      return 1;
    }
    const forges = forgeKey === null ? config.forgeIds : [forgeKey];

    const queue = new JobQueue();
    for (const key of forges) {
      await queue.enqueue({
        tenantId: tenant.id,
        kind: 'sync-repo-list',
        payload: { forgeKey: key },
        dedupeKey: `sync-repo-list:${key}`,
      });
    }
    log.info('repository list sync enqueued', { forges });
    process.stdout.write(
      `The repository list sync is queued for ${forges.join(', ')}. To find out which repositories the worker found, run \`speicher repos list\` once it has finished.\n`,
    );
    return 0;
  },
};
