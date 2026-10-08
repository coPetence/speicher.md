import { resolveRepo } from '../../common/inspect';
import { rootLogger } from '../../common/logger';
import { tenancy } from '../../db/tenancy';
import { JobQueue } from '../../jobs/queue';
import { Command, UsageError } from '../command-types';

export function parseSyncRepoContent(argv: string[]): { repo: string } {
  if (argv.length !== 1) {
    throw new UsageError(
      `sync-repo-content: Expected one repository, written as \`<namespace>/<slug>\` or \`<slug>\`, but received ${argv.length} arguments.`,
    );
  }
  const repo = argv[0];
  if (repo.startsWith('-'))
    throw new UsageError(`sync-repo-content: ${JSON.stringify(repo)} is an unknown argument.`);
  return { repo };
}

export const syncRepoContentCommand: Command = {
  summary:
    'Fetches the newest commit of one repository and rebuilds its pages, assets and search data from it. If the commit has not changed since the last successful sync, nothing is rebuilt. You name the repository as `<namespace>/<slug>`, or as `<slug>` alone if no other namespace uses it. The command only queues the work, and the worker carries it out.',
  args: '<namespace>/<slug>',
  needsCurrentSchema: true,
  check: (argv) => void parseSyncRepoContent(argv),
  run: async (argv) => {
    const log = rootLogger.child('sync-repo-content');
    const { repo } = parseSyncRepoContent(argv);
    const tenant = await tenancy.defaultTenant();
    const matches = await resolveRepo(tenant.id, repo);

    if (matches.length === 0) {
      process.stderr.write(
        `No repository called ${JSON.stringify(repo)} is registered. To find out which repositories are registered, run \`speicher repos list\`.\n`,
      );
      return 1;
    }
    if (matches.length > 1) {
      process.stderr.write(
        `The name ${JSON.stringify(repo)} is used by ${matches.length} repository owners: ${matches.map((m) => `${m.namespace}/${m.slug}`).join(', ')}. Name the repository together with its owner, for example ${matches[0].namespace}/${matches[0].slug}.\n`,
      );
      return 1;
    }

    const [only] = matches;
    await new JobQueue().enqueue({
      tenantId: tenant.id,
      kind: 'sync-repo-content',
      payload: { repoId: only.id, trigger: 'manual' },
      dedupeKey: `sync-repo-content:${only.id}`,
    });
    log.info('sync enqueued', { repo_id: only.id });
    process.stdout.write(`The content sync is queued for ${only.namespace}/${only.slug}.\n`);
    return 0;
  },
};
