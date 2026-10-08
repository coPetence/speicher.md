/**
 * Worker entry point for background job processing
 *
 * Loads the app context without an HTTP server and runs the job worker loop
 * Guards on env, schema, embeddings resolution hash before starting
 *
 * Shuts down on SIGTERM and SIGINT: stops worker, closes Nest app, closes DB
 * Exits 1 on uncaught bootstrap error
 */

import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { assertKnownEnv } from './common/env';
import { rootLogger } from './common/logger';
import { assertSchemaCurrent } from './db/migrate';
import { initModels } from './db/models';
import { closeSequelize, getSequelize } from './db/sequelize';
import { Worker } from './jobs/worker';
import { checkEmbeddingDimensions } from './embed/embedding-guard';
import { checkResolutionHash } from './config/resolution-guard';

async function bootstrap(): Promise<void> {
  // Env, schema, and ops guard smoke checks before Nest boots
  assertKnownEnv();

  const log = rootLogger.child('worker-main');
  initModels(getSequelize());
  await assertSchemaCurrent();
  await checkResolutionHash();

  await checkEmbeddingDimensions();

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const worker = app.get(Worker);
  await worker.start();

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info('shutting down', { signal });
      void worker
        .stop()
        .then(() => app.close())
        .then(() => closeSequelize())
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}

if (require.main === module) {
  bootstrap().catch((err) => {
    rootLogger.child('worker-main').error('failed to start', { error: (err as Error).message });
    process.exit(1);
  });
}
