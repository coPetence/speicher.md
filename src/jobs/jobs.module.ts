import { Module } from '@nestjs/common';

import { ConfigService } from '../config/config.service';
import { TenancyService } from '../db/tenancy';
import { getSequelize } from '../db/sequelize';
import { ForgeRegistry } from '../forge/registry';
import { DirectoryWebhookController } from '../auth/directory/webhook.controller';
import { WebhookController } from '../forge/webhook.controller';
import { EmbedModule } from '../embed/embed.module';
import { EmbedService } from '../embed/embed.service';
import { IngestModule } from '../ingest/ingest.module';
import { IngestService } from '../ingest/ingest.service';
import { Mailer } from '../notify/mailer';
import { NotifyService } from '../notify/notify.service';
import { RoutingService } from '../content-reader/routing';
import { JobQueue } from './queue';
import { RegistrationService } from './registration.service';
import { SyncService } from './sync.service';
import { Worker } from './worker';

@Module({
  imports: [IngestModule, EmbedModule],
  controllers: [WebhookController, DirectoryWebhookController],
  providers: [
    { provide: JobQueue, useFactory: () => new JobQueue(getSequelize()) },
    {
      provide: RoutingService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new RoutingService(config, getSequelize()),
    },
    {
      provide: ForgeRegistry,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => new ForgeRegistry(c),
    },
    { provide: Mailer, inject: [ConfigService], useFactory: (c: ConfigService) => new Mailer(c) },
    {
      provide: NotifyService,
      inject: [ConfigService, Mailer],
      useFactory: (c: ConfigService, m: Mailer) => new NotifyService(c, m),
    },
    {
      provide: RegistrationService,
      inject: [ConfigService, ForgeRegistry, RoutingService, IngestService],
      useFactory: (c: ConfigService, f: ForgeRegistry, r: RoutingService, i: IngestService) =>
        new RegistrationService(c, f, r, i),
    },
    {
      provide: SyncService,
      inject: [ForgeRegistry, IngestService, RoutingService, NotifyService],
      useFactory: (f: ForgeRegistry, i: IngestService, r: RoutingService, n: NotifyService) =>
        new SyncService(f, i, r, n),
    },
    {
      provide: Worker,
      inject: [
        JobQueue,
        SyncService,
        IngestService,
        RegistrationService,
        NotifyService,
        ForgeRegistry,
        TenancyService,
        ConfigService,
        EmbedService,
      ],
      useFactory: (
        queue: JobQueue,
        sync: SyncService,
        ingest: IngestService,
        registration: RegistrationService,
        notify: NotifyService,
        forges: ForgeRegistry,
        tenancy: TenancyService,
        config: ConfigService,
        embed: EmbedService,
      ) => new Worker(queue, sync, ingest, registration, notify, forges, tenancy, config, embed),
    },
  ],
  exports: [JobQueue, Worker, SyncService, ForgeRegistry, RegistrationService, NotifyService],
})
export class JobsModule {}
