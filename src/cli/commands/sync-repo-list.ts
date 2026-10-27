import { rootLogger } from '../../common/logger';
import { ConfigService } from '../../config/config.service';
import { loadActiveInstanceConfig } from '../../config/loader';
import { tenancy } from '../../db/tenancy';
import { JobQueue } from '../../jobs/queue';
import { Command, UsageError } from '../command-types';

export function parseSyncRepoList(argv: string[]): { forgeKey: string | null } {
  if (argv.length > 1)
    throw new UsageError(
      'usage.argument-count',
      `sync-repo-list: Expected at most one forge argument; got ${argv.length}.`,
    );
  const forgeKey = argv[0];
  if (forgeKey !== undefined && forgeKey.startsWith('-')) {
    throw new UsageError(
      'usage.unknown-argument',
      `sync-repo-list: Unknown argument ${JSON.stringify(forgeKey)}.`,
      forgeKey,
    );
  }
  return { forgeKey: forgeKey ?? null };
}

export const syncRepoListCommand: Command = {
  summary:
    'Queue a repository list sync for one forge or all configured forges. Adds new repositories, updates renamed ones, and removes missing ones. Does not wait for completion.',
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
        `Forge ${JSON.stringify(forgeKey)} is not configured. List configured forges: \`speicher forges list\`.\n`,
      );
      return 1;
    }

    if (config.forgeIds.length === 0) {
      process.stderr.write('No forges configured.\n');
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
    log.info('Repository list sync queued', { forges });
    process.stdout.write(
      `Repository list sync queued for ${forges.join(', ')}. After it finishes, view repositories: \`speicher repos list\`.\n`,
    );
    return 0;
  },
};
