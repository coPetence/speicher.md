import { Module } from '@nestjs/common';

import { BlobStore, blobStoreFor } from '../assets/blob-store';
import { ConfigService } from '../config/config.service';
import { getSequelize } from '../db/sequelize';
import { IngestService } from './ingest.service';

export const BLOB_STORE = 'BLOB_STORE';

@Module({
  providers: [
    {
      provide: BLOB_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => blobStoreFor(config),
    },
    {
      provide: IngestService,
      inject: [ConfigService, BLOB_STORE],
      useFactory: (config: ConfigService, blobs: BlobStore) =>
        new IngestService(config, blobs, getSequelize()),
    },
  ],
  exports: [IngestService, BLOB_STORE],
})
export class IngestModule {}
