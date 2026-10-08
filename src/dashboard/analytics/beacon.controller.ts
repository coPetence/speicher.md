/**
 * Beacon endpoint for page-view analytics
 *
 * Single POST endpoint, always returns 204 with no-store
 * Browsers send views via a tracking script
 */
import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { callerOf } from '../../auth/caller.middleware';
import { PageRepository } from '../../authz/content/pages.repository';
import { PUBLIC_PRINCIPAL } from '../../common/principals';
import { splitPath } from '../../common/slug';
import { RoutingService } from '../../content-reader/routing';
import { AnalyticsService } from './analytics.service';

@Controller('api/analytics')
export class BeaconController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly pages: PageRepository,
    private readonly routing: RoutingService,
  ) {}

  @Post('view')
  async view(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { path?: unknown },
  ): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.status(204);

    const caller = callerOf(req);
    const path = typeof body?.path === 'string' ? body.path : '';
    if (!path) {
      res.end();
      return;
    }

    const segments = splitPath(decodeURIComponent(path));
    if (segments === null || segments.length === 0) {
      res.end();
      return;
    }

    const route = await this.routing.resolve(caller.tenantId, segments);

    if (!route || route.redirectTo) {
      res.end();
      return;
    }

    const page = await this.pages.getPage(
      [PUBLIC_PRINCIPAL],
      caller.tenantId,
      route.repoId,
      route.slugPath,
    );
    if (page) {
      this.analytics.recordBeaconView(caller, route.repoId, route.slugPath);
    }
    res.end();
  }
}
