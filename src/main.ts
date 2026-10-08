/**
 * Not a HTTP health-check: the process exits if any guard fails, keeping the
 * orchestrator from routing traffic to a misconfigured instance
 */

import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { installErrorHandler } from './app-errors';
import { configureApp } from './app-setup';
import { AppModule } from './app.module';
import { assertKnownEnv, env } from './common/env';
import { rootLogger } from './common/logger';
import { assertSchemaCurrent } from './db/migrate';
import { initModels } from './db/models';
import { closeSequelize, getSequelize } from './db/sequelize';
import { checkEmbeddingDimensions } from './embed/embedding-guard';
import { checkResolutionHash } from './config/resolution-guard';

export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
    // Raw body needed for webhook signature verification
    rawBody: true,
  });

  configureApp(app);
  app.disable('x-powered-by');
  // Must init before installing the error handler so Express middleware is wired
  await app.init();
  installErrorHandler(app);

  return app;
}

async function bootstrap(): Promise<void> {
  // Checks if there is any misconfigured env variable that starts with 'SPEICHER_' and throws an error if so
  assertKnownEnv();

  const log = rootLogger.child('main');
  initModels(getSequelize());

  await assertSchemaCurrent();

  await checkResolutionHash();

  await checkEmbeddingDimensions();

  const app = await createApp();
  const port = env('PORT');
  await app.listen(port, '0.0.0.0');
  log.info('listening', { port });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info('shutting down', { signal });
      void app
        .close()
        .then(() => closeSequelize())
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}

if (require.main === module) {
  bootstrap().catch((err) => {
    rootLogger.child('main').error('failed to start', { error: (err as Error).message });
    process.exit(1);
  });
}
