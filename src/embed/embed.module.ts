/**
 * Embedding module
 *
 * Provides EMBEDDING_CLIENT and EmbedService, both possibly null
 * Embedding is optional: when config omits the `embedding` section the client
 * is null and search falls back to keyword-only
 *
 * Exports both so the search module can embed queries and the jobs module can
 * batch-embed unembedded chunks
 */

import { Module } from '@nestjs/common';

import { ConfigService } from '../config/config.service';
import { EmbeddingClient, EmbeddingClientDeps } from './client';
import { EmbedService } from './embed.service';

/** NestJS DI token for the embedding client */
export const EMBEDDING_CLIENT = Symbol('EMBEDDING_CLIENT');

/**
 * Returns null when embedding is not configured
 *
 * Not configured: the rest of the app handles a null client
 */
export function createEmbeddingClient(
  config: ConfigService,
  deps: EmbeddingClientDeps = {},
): EmbeddingClient | null {
  const embedding = config.embedding;
  return embedding ? new EmbeddingClient(embedding, deps) : null;
}

@Module({
  providers: [
    {
      provide: EMBEDDING_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createEmbeddingClient(config),
    },
    {
      provide: EmbedService,
      inject: [EMBEDDING_CLIENT],
      useFactory: (client: EmbeddingClient | null) => new EmbedService(client),
    },
  ],
  exports: [EMBEDDING_CLIENT, EmbedService],
})
/** Wires up the embedding client and service */
export class EmbedModule {}
