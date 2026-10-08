import { rootLogger } from '../../common/logger';
import { ConfigService } from '../../config/config.service';
import { loadActiveInstanceConfig } from '../../config/loader';
import { tenancy } from '../../db/tenancy';
import { reembed } from '../../embed/reembed';
import { Command, UsageError } from '../command-types';

export function parseReembed(argv: string[]): void {
  if (argv.length > 0) {
    throw new UsageError(`reembed: Expected no arguments, but received ${argv.length}.`);
  }
}

export const reembedCommand: Command = {
  summary:
    'Recomputes the embeddings of every chunk that was embedded with a different model or number of dimensions than the configured one. Does nothing if no embedding is configured.',
  args: '',
  needsCurrentSchema: true,
  check: parseReembed,
  run: async (argv) => {
    const log = rootLogger.child('embed');
    parseReembed(argv);
    const tenant = await tenancy.defaultTenant();
    const result = await reembed(tenant.id, new ConfigService(await loadActiveInstanceConfig()));
    // No embedding configured is valid; warn and succeed
    if (!result) {
      log.warn('no embedding configured; nothing to re-embed');
      return 0;
    }
    log.info('done', { cleared: result.cleared, pending: result.pending });
    return 0;
  },
};
