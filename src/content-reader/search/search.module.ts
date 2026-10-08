/**
 * Nest module wiring search providers
 *
 * KeywordSearch is a shared provider so HybridSearch can inject it
 * SearchService wraps HybridSearch; only SearchService is exported
 */
import { Module } from '@nestjs/common';

import { SearchRepository } from '../../authz/content/search.repository';
import { ConfigService } from '../../config/config.service';
import { EMBEDDING_CLIENT, EmbedModule } from '../../embed/embed.module';
import { EmbeddingClient } from '../../embed/client';
import { HybridSearch, KeywordSearch, SearchService } from './search.service';

@Module({
  imports: [EmbedModule],
  providers: [
    {
      provide: KeywordSearch,
      inject: [SearchRepository, ConfigService],
      useFactory: (content: SearchRepository, config: ConfigService) =>
        new KeywordSearch(content, config),
    },
    {
      provide: SearchService,
      inject: [SearchRepository, ConfigService, KeywordSearch, EMBEDDING_CLIENT],
      useFactory: (
        content: SearchRepository,
        config: ConfigService,
        keyword: KeywordSearch,
        client: EmbeddingClient | null,
      ) => new SearchService(new HybridSearch(content, config, keyword, client)),
    },
  ],
  exports: [SearchService],
})
export class SearchModule {}
