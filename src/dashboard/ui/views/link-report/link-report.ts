import type { Request, Response } from 'express';

import { Level } from '../../levels';
import { DashboardResponder } from '../../../respond';
import { GraphPageRow, GraphReport } from '../../../../authz/content/types';
import { RoutingService } from '../../../../content-reader/routing';
import { renderTemplate } from '../../../../content-reader/views';

/** Sends the link report: most-linked, unlinked, dangling and narrowing pages */
export function sendGraph(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  routing: RoutingService,
  payload: GraphReport,
): void {
  const pageHref = (row: GraphPageRow) =>
    routing.publicPathFor(
      { namespace: row.repo_namespace, slug: row.repo_slug, forge_key: row.forge_key },
      row.slug_path,
    );

  respond.send(req, res, isAdmin, {
    section: 'graph',
    title: 'Link report',
    payload,
    page: (data) =>
      renderTemplate('dashboard/ui/views/link-report', {
        tiles: [
          { label: 'Pages', value: String(data.pages), level: 'idle' as Level },
          { label: 'Links', value: String(data.edges), level: 'idle' as Level },
          { label: 'Terms', value: String(data.terms), level: 'idle' as Level },
          {
            label: 'Dangling links',
            value: String(data.dangling.length),
            level: data.dangling.length > 0 ? ('fail' as Level) : ('ok' as Level),
          },
          {
            label: 'Narrowing links',
            value: String(data.narrowing.length),
            level: data.narrowing.length > 0 ? ('warn' as Level) : ('ok' as Level),
          },
        ],
        mostLinked: data.most_linked.map((row) => ({
          name: `${row.repo_namespace}/${row.repo_slug}`,
          title: row.title,
          href: pageHref(row),
          inbound: row.inbound,
        })),
        unlinked: data.unlinked.map((row) => ({
          name: `${row.repo_namespace}/${row.repo_slug}`,
          title: row.title,
          href: pageHref(row),
        })),
        dangling: data.dangling,
        narrowing: data.narrowing,
      }),
  });
}
