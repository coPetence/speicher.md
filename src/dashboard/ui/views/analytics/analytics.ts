import type { Request, Response } from 'express';

import { Level } from '../../levels';
import { barChart, densify } from '../../chart';
import { DashboardResponder } from '../../../respond';
import {
  NeverRead,
  PageCount,
  SearchMiss,
  SeriesPoint,
  Totals,
} from '../../../analytics/analytics.repository';
import { AnalyticsConfig } from '../../../../config/types';
import { RoutingService } from '../../../../content-reader/routing';
import { renderTemplate } from '../../../../content-reader/views';

/** The reads report, or only its window when analytics is off */
export type AnalyticsPayload =
  | { enabled: false; window_days: number }
  | {
      enabled: true;
      window_days: number;
      settings: Required<Omit<AnalyticsConfig, 'enabled'>>;
      totals: Totals;
      top_pages: PageCount[];
      search_misses: SearchMiss[];
      never_read: { rows: NeverRead[]; total: number };
      series: SeriesPoint[];
    };

/** Sends the reads report over the analytics window */
export function sendAnalytics(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  routing: RoutingService,
  payload: AnalyticsPayload,
): void {
  respond.send(req, res, isAdmin, {
    section: 'analytics',
    title: 'Analytics',
    payload,
    page: (data) =>
      renderTemplate('dashboard/ui/views/analytics', {
        enabled: data.enabled,
        windowDays: data.window_days,
        ...(data.enabled
          ? {
              timezone: data.settings.timezone,
              granularity: data.settings.granularity,
              uniqueReaders: data.settings.unique_readers,
              beacon: data.settings.public_beacon,
              tiles: [
                {
                  label: 'Web views',
                  value: String(data.totals.webViews),
                  level: 'idle' as Level,
                },
                {
                  label: 'MCP views',
                  value: String(data.totals.mcpViews),
                  level: 'idle' as Level,
                },
                {
                  label: 'Pages read',

                  value: `${data.totals.pagesRead} of ${data.totals.pagesTotal}`,
                  level: 'idle' as Level,
                },
                {
                  label: 'Search misses',
                  value: String(data.search_misses.reduce((sum, row) => sum + row.misses, 0)),
                  level: data.search_misses.length > 0 ? ('warn' as Level) : ('ok' as Level),
                },
              ],

              chart: barChart(
                densify(
                  data.series,
                  new Date(),
                  data.settings.granularity === 'hour' ? data.window_days * 24 : data.window_days,
                  data.settings.timezone,
                  data.settings.granularity,
                ),
                `Reads per ${data.settings.granularity} over the last ${data.window_days} days`,
              ),
              topPages: data.top_pages.map((row) => ({
                repo: `${row.repoNamespace}/${row.repoSlug}`,
                title: row.title,
                href: routing.publicPathFor(
                  {
                    namespace: row.repoNamespace,
                    slug: row.repoSlug,
                    forge_key: row.forgeKey,
                  },
                  row.slugPath,
                ),
                webViews: row.webViews,
                mcpViews: row.mcpViews,
                readers: row.readers,
              })),
              searchMisses: data.search_misses,
              neverRead: data.never_read.rows.map((row) => ({
                repo: `${row.repoNamespace}/${row.repoSlug}`,
                title: row.title,
              })),
              neverReadTotal: data.never_read.total,
            }
          : {}),
      }),
  });
}
