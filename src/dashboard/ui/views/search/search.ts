import type { Request, Response } from 'express';

import { renderHelp } from '../../../configurator/config-form/help';
import { DashboardResponder } from '../../../respond';
import { DashboardHit } from '../../../search/search';
import { renderInlineIcon } from '../../../../content-reader/icons';
import { renderTemplate } from '../../../../content-reader/views';

/** What the admin search answers, to JSON callers and the page alike */
export interface DashboardSearchPayload {
  query: string;
  hits: DashboardHit[];
  total: number;
  settings_searchable: boolean;
}

/** Sends the admin search page over pages, config sections and settings */
export function sendDashboardSearch(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: DashboardSearchPayload,
): void {
  respond.send(req, res, isAdmin, {
    section: 'search',
    title: payload.query ? `Search: ${payload.query}` : 'Search',

    searchQuery: payload.query,
    payload,
    page: (data) =>
      renderTemplate('dashboard/ui/views/search', {
        ...data,

        shown: data.hits.length,
        hits: data.hits.map((hit) => ({
          ...hit,

          help_html: renderHelp(hit.help),
        })),

        hit_icons: Object.fromEntries(
          data.hits
            .map((hit) => hit.icon)
            .filter((icon) => icon !== '')
            .map((icon) => [icon, renderInlineIcon(icon, 'spr-icon')]),
        ),
      }),
  });
}
