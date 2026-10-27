import { rootLogger } from '../../common/logger';
import { ConfigService } from '../../config/config.service';
import { loadActiveInstanceConfig } from '../../config/loader';
import { tenancy } from '../../db/tenancy';
import { reembed } from '../../embed/reembed';
import { Command, UsageError } from '../command-types';

export function parseReembed(argv: string[]): void {
  if (argv.length > 0) {
    throw new UsageError(
      'usage.argument-count',
      `reembed takes no arguments; received ${argv.length}.`,
    );
  }
}

export const reembedCommand: Command = {
  summary:
    'Re-embeds chunks whose model or dimensions differ from the current configuration. Skips if embeddings are not configured.',
  args: '',
  needsCurrentSchema: true,
  check: parseReembed,
  run: async (argv) => {
    const log = rootLogger.child('embed');
    parseReembed(argv);
    const tenant = await tenancy.defaultTenant();
    const result = await reembed(tenant.id, new ConfigService(await loadActiveInstanceConfig()));
    // Warn and succeed if embeddings are not configured
    if (!result) {
      log.warn('Embeddings are not configured. Skipping re-embedding.');
      return 0;
    }
    log.info('Re-embedding check complete.', { cleared: result.cleared, pending: result.pending });
    return 0;
  },
};
