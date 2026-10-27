import { resolveRepo } from '../../common/inspect';
import { rootLogger } from '../../common/logger';
import { tenancy } from '../../db/tenancy';
import { JobQueue } from '../../jobs/queue';
import { Command, UsageError } from '../command-types';

export function parseSyncRepoContent(argv: string[]): { repo: string; force: boolean } {
  const unknown = argv.find((arg) => arg.startsWith('-') && arg !== '--force');
  if (unknown !== undefined)
    throw new UsageError(
      'usage.unknown-argument',
      `sync-repo-content: Unknown option ${JSON.stringify(unknown)}. Only --force is supported.`,
      unknown,
    );
  const rest = argv.filter((arg) => arg !== '--force');
  if (rest.length !== 1) {
    throw new UsageError(
      'usage.argument-count',
      `sync-repo-content: Expected 1 repository (<namespace>/<slug> or <slug>), got ${rest.length}.`,
    );
  }
  return { repo: rest[0], force: argv.includes('--force') };
}

export const syncRepoContentCommand: Command = {
  summary:
    'Queue a sync of a repository’s latest commit to rebuild pages, assets and search data. Unchanged commits are skipped unless --force is set. Use <namespace>/<slug>, or <slug> if unique. A worker runs the sync.',
  args: '<namespace>/<slug> [--force]',
  needsCurrentSchema: true,
  check: (argv) => void parseSyncRepoContent(argv),
  run: async (argv) => {
    const log = rootLogger.child('sync-repo-content');
    const { repo, force } = parseSyncRepoContent(argv);
    const tenant = await tenancy.defaultTenant();
    const matches = await resolveRepo(tenant.id, repo);

    if (matches.length === 0) {
      process.stderr.write(
        `Repository ${JSON.stringify(repo)} not found. List repositories with \`speicher repos list\`.\n`,
      );
      return 1;
    }
    if (matches.length > 1) {
      process.stderr.write(
        `Repository name ${JSON.stringify(repo)} is ambiguous. Use a full name: ${matches.map((m) => `${m.namespace}/${m.slug}`).join(', ')}.\n`,
      );
      return 1;
    }

    const [only] = matches;
    await new JobQueue().enqueue({
      tenantId: tenant.id,
      kind: 'sync-repo-content',
      payload: { repoId: only.id, trigger: force ? 'rebuild' : 'manual' },
      dedupeKey: `sync-repo-content:${only.id}`,
    });
    log.info('Sync queued', { repo_id: only.id, forced: force });
    process.stdout.write(
      force
        ? `Forced sync queued for ${only.namespace}/${only.slug}; unchanged commits will be rebuilt.\n`
        : `Sync queued for ${only.namespace}/${only.slug}.\n`,
    );
    return 0;
  },
};
