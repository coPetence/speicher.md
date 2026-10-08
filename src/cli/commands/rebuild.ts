import { rootLogger } from '../../common/logger';
import { Command, UsageError } from '../command-types';
import { enqueueFullRebuild } from '../rebuild';

export function parseRebuild(argv: string[]): { purgeFirst: boolean } {
  for (const arg of argv) {
    if (arg !== '--purge') {
      throw new UsageError(
        `rebuild: ${JSON.stringify(arg)} is an unknown argument. The only option is --purge.`,
      );
    }
  }
  return { purgeFirst: argv.includes('--purge') };
}

export const rebuildCommand: Command = {
  summary:
    'Rebuilds the pages of every repository from its current commit, even if the commit has not changed. With `--purge`, it deletes the stored content first but keeps the search embeddings. The command only queues the work, and the worker carries it out.',
  args: '[--purge]',
  needsCurrentSchema: true,
  check: (argv) => void parseRebuild(argv),
  run: async (argv) => {
    const log = rootLogger.child('rebuild');
    const repos = await enqueueFullRebuild(parseRebuild(argv));
    log.info('done', { repos });
    return 0;
  },
};
