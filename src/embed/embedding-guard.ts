import { rootLogger } from '../common/logger';
import { ConfigService } from '../config/config.service';
import { loadActiveInstanceConfig } from '../config/loader';
import { EmbeddingClient, EmbeddingDimensionError } from './client';
import { createEmbeddingClient } from './embed.module';

/**
 * Health probe for the embedding endpoint
 *
 * Checks that the embedding provider is reachable and returns a known dimension count
 * An unreachable endpoint is tolerated; the server starts, and the frontend shows a
 * warning banner
 *
 * EmbeddingDimensionError is rethrown: a mismatched dimension is a build-breaking
 * failure, unlike a transient network issue
 */
export type EmbeddingProbe =
  | { status: 'unconfigured' }
  | { status: 'ok'; dimensions: number }
  | { status: 'unreachable'; reason: string };

/**
 * Verify embedding dimensions against the configured provider
 */
export async function checkEmbeddingDimensions(
  config?: ConfigService,
  client?: EmbeddingClient | null,
): Promise<EmbeddingProbe> {
  const log = rootLogger.child('embed');

  const service = config ?? new ConfigService(await loadActiveInstanceConfig());
  const embedder = client === undefined ? createEmbeddingClient(service) : client;
  if (!embedder) return { status: 'unconfigured' };

  try {
    const dimensions = await embedder.verifyDimensions();
    log.info('embedding endpoint verified', { model: embedder.model, dimensions });
    return { status: 'ok', dimensions };
  } catch (err) {
    if (err instanceof EmbeddingDimensionError) throw err;
    const reason = (err as Error).message;
    log.error('embedding endpoint could not be verified; starting anyway', {
      model: embedder.model,
      error: reason,
    });
    return { status: 'unreachable', reason };
  }
}
