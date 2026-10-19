/**
 * NestJS application root module
 *
 * Tenanted single-instance NestJS app serving the full Speicher API surface
 * Imports feature modules for config, authz, ingest, search, embed and jobs
 * Registers all controllers and providers directly to keep the module graph flat
 * Middleware stack is caller resolution, rate limiting, then setup redirect
 *
 * CIMD_DEPS and DIRECTORY_DEPS are provided as null in the default build
 * because the enterprise directory integrations are compiled out
 */
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';

import { RateLimitMiddleware } from './app-rate-limit';
import { AnalyticsRepository } from './dashboard/analytics/analytics.repository';
import { AnalyticsService } from './dashboard/analytics/analytics.service';
import { BeaconController } from './dashboard/analytics/beacon.controller';

import { DashboardController } from './dashboard/dashboard.controller';
import { DashboardRepository } from './dashboard/dashboard.repository';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { ConfigController } from './dashboard/configurator/config.controller';
import { ConnectionsController } from './dashboard/connections.controller';
import { ConfigPageService } from './dashboard/configurator/config-page/config-page.service';
import { ConfigWatcher } from './config/watcher';
import { SectionChecks } from './dashboard/configurator/config-page/checks';
import { ConfigSaveService } from './dashboard/configurator/config-page/save';
import { BlobStore } from './assets/blob-store';
import { GraphDirectoryDeps } from './auth/directory/graph';
import { DIRECTORY_DEPS } from './auth/directory/lookup';
import { DashboardResponder } from './dashboard/respond';
import { StatusService } from './dashboard/status/status.service';
import { ApiKeyService } from './auth/api-key.service';
import { OauthController } from './auth/oauth/oauth.controller';
import { OauthMetadataController } from './auth/oauth/metadata.controller';
import { OauthService } from './auth/oauth/oauth.service';
import { CIMD_DEPS } from './auth/oauth/cimd';
import { AuthController } from './auth/auth.controller';
import { MagicLinkService } from './auth/magic-link.service';
import { GithubAuthService } from './auth/github.service';
import { OidcService } from './auth/oidc.service';
import { CallerMiddleware } from './auth/caller.middleware';
import { SessionService } from './auth/session.service';
import { AuthzService } from './authz/authz.service';
import { AuthzModule } from './authz/authz.module';
import { PageRepository } from './authz/content/pages.repository';
import { ContentReports } from './authz/content/reports';
import { ConfigModule } from './config/config.module';
import { ConfigService } from './config/config.service';
import { getSequelize } from './db/sequelize';
import { EmbedModule } from './embed/embed.module';
import { BLOB_STORE, IngestModule } from './ingest/ingest.module';
import { JobsModule } from './jobs/jobs.module';
import { McpController } from './mcp/mcp.controller';
import { McpTools } from './mcp/tools';
import { AppearanceController } from './content-reader/appearance.controller';
import {
  BrandController,
  FaviconController,
  StaticController,
} from './content-reader/assets.controller';
import { CrawlerController } from './content-reader/crawlers.controller';
import { ReadController } from './content-reader/read.controller';
import { RoutingService } from './content-reader/routing';
import { SearchModule } from './content-reader/search/search.module';
import { SetupController } from './dashboard/setup/setup.controller';
import { SetupWizardController } from './dashboard/setup/wizard.controller';
import { SetupRedirectMiddleware } from './dashboard/setup/setup-redirect.middleware';
import { SetupService, setup } from './dashboard/setup/setup.service';
import { Mailer } from './notify/mailer';
import { SearchService } from './content-reader/search/search.service';

@Module({
  imports: [ConfigModule, AuthzModule, IngestModule, SearchModule, EmbedModule, JobsModule],
  controllers: [
    HealthController,
    DashboardController,
    ConfigController,
    // Liveness and readiness probes
    ConnectionsController,
    // Active WebSocket connections, admin only
    SetupWizardController,
    AuthController,
    // Login, logout, session status
    OauthController,
    // OAuth 2.0 authorisation endpoint for MCP clients
    SetupController,
    // Bootstrap flow (first-administrator claim)
    BeaconController,
    // Analytics beacon ingestion
    AppearanceController,
    McpController,
    StaticController,
    BrandController,
    // Branded static assets
    FaviconController,
    CrawlerController,
    // Crawler user-agent management
    OauthMetadataController,
    ReadController,
  ],
  providers: [
    SessionService,
    ApiKeyService,
    OauthService,
    // Null by default; integrated tests override
    { provide: CIMD_DEPS, useValue: null },
    // SetupService is the singleton, not a class instance
    { provide: SetupService, useValue: setup },
    DashboardRepository,
    AnalyticsRepository,
    {
      provide: AnalyticsService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new AnalyticsService(config),
    },
    {
      provide: DashboardResponder,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new DashboardResponder(config),
    },
    {
      provide: HealthService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new HealthService(config),
    },
    {
      provide: StatusService,
      inject: [AuthzService, ConfigService, ContentReports, DashboardRepository],
      useFactory: (
        authz: AuthzService,
        config: ConfigService,
        reports: ContentReports,
        repo: DashboardRepository,
      ) => new StatusService(authz, config, reports, repo),
    },
    // Null by default; integrated tests override
    { provide: DIRECTORY_DEPS, useValue: null },
    {
      provide: ConfigPageService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new ConfigPageService(config),
    },
    {
      provide: SectionChecks,
      // Graph directory and blob store are optional; null deps produce degraded pages
      inject: [ConfigService, DIRECTORY_DEPS, BLOB_STORE],
      useFactory: (
        config: ConfigService,
        directoryDeps: GraphDirectoryDeps | null,
        blobs: BlobStore,
      ) => new SectionChecks(config, directoryDeps, blobs),
    },
    {
      provide: ConfigSaveService,
      inject: [ConfigService, ConfigPageService, SectionChecks, ConfigWatcher],
      useFactory: (
        config: ConfigService,
        page: ConfigPageService,
        checks: SectionChecks,
        watcher: ConfigWatcher,
      ) => new ConfigSaveService(config, page, checks, watcher),
    },
    { provide: Mailer, inject: [ConfigService], useFactory: (c: ConfigService) => new Mailer(c) },
    {
      provide: OidcService,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => new OidcService(c),
    },
    {
      provide: GithubAuthService,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => new GithubAuthService(c),
    },
    {
      provide: MagicLinkService,
      inject: [ConfigService, Mailer],
      useFactory: (c: ConfigService, m: Mailer) => new MagicLinkService(c, m),
    },
    {
      provide: RoutingService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new RoutingService(config, getSequelize()),
    },
    {
      provide: McpTools,
      inject: [PageRepository, RoutingService, SearchService, AnalyticsService],
      useFactory: (
        pages: PageRepository,
        routing: RoutingService,
        search: SearchService,
        analytics: AnalyticsService,
      ) => new McpTools(pages, routing, search, analytics),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Caller resolution, rate limiting, then setup redirect on every route
    consumer
      .apply(CallerMiddleware, RateLimitMiddleware, SetupRedirectMiddleware)
      .forRoutes('{*path}');
  }
}
