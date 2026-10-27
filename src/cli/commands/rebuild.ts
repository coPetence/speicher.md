import { rootLogger } from '../../common/logger';
import { Command, UsageError } from '../command-types';
import { enqueueFullRebuild } from '../rebuild';

export function parseRebuild(argv: string[]): { purgeFirst: boolean } {
  for (const arg of argv) {
    if (arg !== '--purge') {
      throw new UsageError(
        'usage.unknown-argument',
        `rebuild: unknown argument ${JSON.stringify(arg)}. Only --purge is supported.`,
        arg,
      );
    }
  }
  return { purgeFirst: argv.includes('--purge') };
}

export const rebuildCommand: Command = {
  summary:
    'Queue a rebuild of all repository pages from their current commits, even if unchanged. --purge deletes stored content first but keeps search embeddings. A worker runs the rebuild.',
  args: '[--purge]',
  needsCurrentSchema: true,
  check: (argv) => void parseRebuild(argv),
  run: async (argv) => {
    const log = rootLogger.child('rebuild');
    const repos = await enqueueFullRebuild(parseRebuild(argv));
    log.info('Rebuild queued', { repos });
    return 0;
  },
};
