import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { callerOf } from '../auth/caller.middleware';
import { createDirectoryLookup, groupReach } from '../auth/directory/lookup';
import { ContentReports } from '../authz/content/reports';
import { explainPath } from '../authz/explain';
import { splitPath } from '../common/slug';
import { ConfigService } from '../config/config.service';
import { RoutingService } from '../content-reader/routing';
import { reembed } from '../embed/reembed';
import { JobQueue } from '../jobs/queue';
import { AnalyticsRepository } from './analytics/analytics.repository';
import { buildSections } from './configurator/config-form/fields';
import { ConfigPageService } from './configurator/config-page/config-page.service';
import { isDashboardSectionDisabled } from './dashboard-sections';
import { DashboardRepository } from './dashboard.repository';
import { DashboardResponder, dashboardNavOptions, wantsJson } from './respond';
import { searchDashboard } from './search/search';
import { rememberFilter, rememberedFilter } from './status/filter-cookie';
import { DEFAULT_REPO_FILTER, repoFilterFrom } from './status/repo-filter';
import { repoSortFrom } from './status/repo-sort';
import { StatusService } from './status/status.service';
import { AnalyticsPayload, sendAnalytics } from './ui/views/analytics/analytics';
import { sendGraph } from './ui/views/link-report/link-report';
import { sendExplain } from './ui/views/path-access-check/path-access-check';
import { sendDashboardSearch } from './ui/views/search/search';
import { sendDeadJobs } from './ui/views/sync-status/dead-jobs/dead-jobs';
import { sendRepo } from './ui/views/sync-status/repo-status/repo-status';
import { sendRun } from './ui/views/sync-status/run-status/run-status';
import { sendStatus } from './ui/views/sync-status/status-overview/status-overview';

const DEAD_JOBS_PER_PAGE = 50;

function pageParam(raw: unknown): string {
  const page = typeof raw === 'string' ? countFromQuery(raw) : null;
  return page && page > 1 ? `&page=${page}` : '';
}

function jobIdsOf(
  body: { id?: unknown; ids?: unknown; scope?: unknown } | undefined,
): string[] | null {
  if (typeof body?.id === 'string' && body.id !== '') return [body.id];
  if (body?.scope !== 'selected') return null;
  const ids = Array.isArray(body.ids) ? body.ids : [body.ids];
  return ids.filter((id): id is string => typeof id === 'string' && id !== '');
}

/** Parses a count query param; null when absent or not a non-negative integer */
function countFromQuery(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Dashboard routes, all under `/-`
 *
 * Every route answers HTML or JSON via DashboardResponder, per the Accept header
 * Status, explain and repo-status run for anyone with operational scope, not only admins
 */
@Controller('-')
export class DashboardController {
  constructor(
    private readonly status: StatusService,
    private readonly routing: RoutingService,
    private readonly reports: ContentReports,
    private readonly repo: DashboardRepository,
    private readonly respond: DashboardResponder,
    private readonly config: ConfigService,

    private readonly analyticsRepo: AnalyticsRepository,

    private readonly page: ConfigPageService,

    private readonly queue: JobQueue,
  ) {}

  private static readonly ANALYTICS_WINDOW_DAYS = 30;

  /** Re-embeds the corpus with the current embedding model */
  @Post('reembed')
  async reembedCorpus(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const result = await reembed(caller.tenantId, this.config);

    if (!result) return this.respond.notFound(req, res);

    res.setHeader('Vary', 'Accept');
    res.setHeader('Cache-Control', 'private, no-store');
    if (wantsJson(req)) {
      res.status(200).json(result);
      return;
    }
    res.redirect(303, `/-/status?reembedding=${result.pending}`);
  }

  /** Queues discovery for every configured forge */
  @Post('discover')
  async discoverForges(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const forges = this.config.forgeIds;
    if (forges.length === 0) return this.respond.notFound(req, res);

    for (const forgeKey of forges) {
      await this.queue.enqueue({
        tenantId: caller.tenantId,
        kind: 'sync-repo-list',
        payload: { forgeKey },
        dedupeKey: `sync-repo-list:${forgeKey}`,
      });
    }

    res.setHeader('Vary', 'Accept');
    res.setHeader('Cache-Control', 'private, no-store');
    if (wantsJson(req)) {
      res.status(200).json({ discovering: forges });
      return;
    }
    res.redirect(303, '/-/status');
  }

  /** Queues a manual sync of one repository, deduplicated against pending jobs */
  @Post('sync')
  async syncRepository(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { namespace?: unknown; slug?: unknown },
  ): Promise<void> {
    const caller = callerOf(req);
    const namespace = typeof body?.namespace === 'string' ? body.namespace : '';
    const slug = typeof body?.slug === 'string' ? body.slug : '';
    const repoId = await this.status.operableRepoId(caller, namespace, slug);

    if (!repoId) return this.respond.notFound(req, res);

    await this.queue.enqueue({
      tenantId: caller.tenantId,
      kind: 'sync-repo-content',
      payload: { repoId, trigger: 'manual' },
      dedupeKey: `sync-repo-content:${repoId}`,
    });

    res.setHeader('Vary', 'Accept');
    res.setHeader('Cache-Control', 'private, no-store');
    if (wantsJson(req)) {
      res.status(200).json({ syncing: `${namespace}/${slug}` });
      return;
    }
    // No `?syncing=` flag: the page asks the queue, so a reload is a fresh answer
    res.redirect(303, `/-/status/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`);
  }

  /** Retries dead jobs: all of them, or the one given in the body */
  @Post('jobs/retry')
  async retryJobs(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { id?: unknown; ids?: unknown; scope?: unknown; page?: unknown },
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const ids = jobIdsOf(body);
    const retried = await this.queue.retryDead({
      tenantId: caller.tenantId,
      ids: ids ?? undefined,
    });

    res.setHeader('Vary', 'Accept');
    res.setHeader('Cache-Control', 'private, no-store');
    if (wantsJson(req)) {
      res.status(200).json({ retried });
      return;
    }
    res.redirect(303, `/-/dead-jobs?retried=${retried}${pageParam(body?.page)}`);
  }

  /** Deletes the dead jobs given in the body, so they are no longer offered for retry */
  @Post('jobs/delete')
  async deleteJob(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { id?: unknown; ids?: unknown; scope?: unknown; page?: unknown },
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const ids = jobIdsOf(body) ?? [];
    const deleted = await this.queue.deleteDead({ tenantId: caller.tenantId, ids });

    res.setHeader('Vary', 'Accept');
    res.setHeader('Cache-Control', 'private, no-store');
    if (wantsJson(req)) {
      res.status(200).json({ deleted });
      return;
    }
    res.redirect(303, `/-/dead-jobs?deleted=${deleted}${pageParam(body?.page)}`);
  }

  /** Renders the admin search page over pages, config sections and settings */
  @Get('search')
  async searchPage(
    @Req() req: Request,
    @Res() res: Response,
    @Query('q') q?: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const query = typeof q === 'string' ? q : '';
    const state = await this.page.state(caller);

    const sections = state.doc ? buildSections(state.doc) : null;
    const found = searchDashboard(query, sections, dashboardNavOptions(this.config));

    sendDashboardSearch(
      this.respond,
      req,
      res,
      caller.isAdmin,
      {
        query,
        hits: found.hits,
        total: found.total,
        settings_searchable: sections !== null,
      },
      state.common,
    );
  }

  /** Renders the sync-status overview: freshness and errors per repository */
  @Get('status')
  async statusPage(
    @Req() req: Request,
    @Res() res: Response,
    @Query('q') q?: string,
    @Query('sort') sort?: string,
    @Query('reembedding') reembedding?: string,
  ): Promise<void> {
    const caller = callerOf(req);
    const scope = await this.status.scopeFor(caller);
    if (scope !== 'all' && scope.length === 0) return this.respond.notFound(req, res);

    const requested = repoFilterFrom(req.query as Record<string, unknown>);
    if (requested) rememberFilter(req, res, requested);
    const filter = requested ?? rememberedFilter(req) ?? DEFAULT_REPO_FILTER;

    sendStatus(
      this.respond,
      req,
      res,
      caller.isAdmin,
      await this.status.statusPayload(
        caller,
        scope,
        typeof q === 'string' ? q : '',
        filter,
        repoSortFrom(sort),
      ),
      { reembedding: countFromQuery(reembedding) },
    );
  }

  /** Renders per-repository status: recent runs, config summary and findings */
  @Get('status/:namespace/:slug')
  async repoStatus(
    @Req() req: Request,
    @Res() res: Response,
    @Param('namespace') namespace: string,
    @Param('slug') slug: string,
  ): Promise<void> {
    const caller = callerOf(req);
    const payload = await this.status.repoRunsPayload(caller, namespace, slug);
    if (!payload) return this.respond.notFound(req, res);

    sendRepo(this.respond, req, res, caller.isAdmin, payload);
  }

  /** Renders one sync run: what it did, what it left serving, and its findings */
  @Get('status/:namespace/:slug/runs/:runId')
  async runStatus(
    @Req() req: Request,
    @Res() res: Response,
    @Param('namespace') namespace: string,
    @Param('slug') slug: string,
    @Param('runId') runId: string,
  ): Promise<void> {
    const caller = callerOf(req);
    const payload = await this.status.runPayload(caller, namespace, slug, runId);
    if (!payload) return this.respond.notFound(req, res);

    sendRun(this.respond, req, res, caller.isAdmin, payload);
  }

  /** Renders the link graph: most-linked, unlinked, dangling and narrowing pages */
  @Get('graph')
  async graph(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin || isDashboardSectionDisabled('graph')) {
      return this.respond.notFound(req, res);
    }

    sendGraph(
      this.respond,
      req,
      res,
      caller.isAdmin,
      this.routing,
      await this.reports.graphReport(caller.tenantId),
    );
  }

  /** Renders the reads report over the last 30 days */
  @Get('analytics')
  async analytics(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin || isDashboardSectionDisabled('analytics')) {
      return this.respond.notFound(req, res);
    }

    const settings = this.config.analytics;
    const since = new Date(Date.now() - DashboardController.ANALYTICS_WINDOW_DAYS * 86_400_000);

    const payload: AnalyticsPayload = settings.enabled
      ? {
          enabled: true as const,
          window_days: DashboardController.ANALYTICS_WINDOW_DAYS,
          settings: {
            timezone: settings.timezone,
            granularity: settings.granularity,
            unique_readers: settings.unique_readers,
            public_beacon: settings.public_beacon,
            retention_days: settings.retention_days,
            search_retention_days: settings.search_retention_days,
          },
          totals: await this.analyticsRepo.totals(caller.tenantId, since),
          top_pages: await this.analyticsRepo.topPages(caller.tenantId, since, 25),
          search_misses: await this.analyticsRepo.searchMisses(caller.tenantId, since, 25),
          never_read: await this.analyticsRepo.neverRead(caller.tenantId, since, 50),

          series: await this.analyticsRepo.series(caller.tenantId, since, settings.granularity),
        }
      : { enabled: false as const, window_days: DashboardController.ANALYTICS_WINDOW_DAYS };

    sendAnalytics(this.respond, req, res, caller.isAdmin, this.routing, payload);
  }

  /** Explains access to a path via the cascade of grant levels */
  @Get('explain')
  async explain(
    @Req() req: Request,
    @Res() res: Response,
    @Query('path') path?: string,
  ): Promise<void> {
    if (isDashboardSectionDisabled('explain')) return this.respond.notFound(req, res);
    const caller = callerOf(req);
    const scope = await this.status.scopeFor(caller);
    if (scope !== 'all' && scope.length === 0) return this.respond.notFound(req, res);

    const asked = typeof path === 'string' ? path.trim() : '';
    if (asked === '') {
      // No path: JSON callers get a 404, others the empty form
      if (wantsJson(req)) return this.respond.notFound(req, res);
      return sendExplain(this.respond, req, res, caller.isAdmin, '', null);
    }

    const segments = splitPath(asked);
    if (segments === null) return this.respond.notFound(req, res);
    const route = await this.routing.resolve(caller.tenantId, segments);
    if (!route) return this.respond.notFound(req, res);

    if (scope !== 'all' && !scope.includes(route.repoId)) return this.respond.notFound(req, res);

    const result = await explainPath(caller.tenantId, route.repoId, route.slugPath, {
      includeGroupSizes: caller.isAdmin,

      // Directory reach (group sizes) is shown to admins only
      reach: caller.isAdmin
        ? async (names) =>
            (await groupReach(this.config, createDirectoryLookup(this.config), names)).map(
              (group) => ({
                name: group.name,
                size: group.size,
                directory_url: group.directoryUrl,
              }),
            )
        : undefined,
    });
    sendExplain(this.respond, req, res, caller.isAdmin, asked, result);
  }

  /** Renders the dead jobs page: the jobs the worker gave up on, each with a Retry */
  @Get('dead-jobs')
  async deadJobs(
    @Req() req: Request,
    @Res() res: Response,
    @Query('retried') retried?: string,
    @Query('deleted') deleted?: string,
    @Query('page') page?: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const total = await this.repo.deadJobCount(caller.tenantId);
    const pages = Math.max(1, Math.ceil(total / DEAD_JOBS_PER_PAGE));
    const current = Math.min(Math.max(1, countFromQuery(page) ?? 1), pages);

    sendDeadJobs(
      this.respond,
      req,
      res,
      caller.isAdmin,
      {
        dead_jobs: await this.repo.deadJobs(caller.tenantId, {
          limit: DEAD_JOBS_PER_PAGE,
          offset: (current - 1) * DEAD_JOBS_PER_PAGE,
        }),
        total,
        page: current,
        pages,
        per_page: DEAD_JOBS_PER_PAGE,
      },
      { retried: countFromQuery(retried), deleted: countFromQuery(deleted) },
    );
  }

  /** The old address of the dead jobs page; a bookmark still lands on the jobs */
  @Get('logs')
  logs(@Req() req: Request, @Res() res: Response): void {
    if (!callerOf(req).isAdmin) return this.respond.notFound(req, res);
    res.redirect(301, '/-/dead-jobs');
  }
}
