import type { Request, Response } from 'express';

import { ConfigOverviewPayload } from '../../../configurator/config-page/payloads';
import { DashboardResponder } from '../../../respond';
import { renderInlineIcon } from '../../../../content-reader/icons';
import { renderTemplate } from '../../../../content-reader/views';

/** Sends the configuration overview */
export function sendConfig(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: ConfigOverviewPayload,
  status?: number,
): void {
  respond.send(req, res, isAdmin, {
    section: 'config',
    title: 'Configuration',
    payload,
    page: (data) =>
      renderTemplate('dashboard/ui/views/config-overview', {
        ...(data as unknown as Record<string, unknown>),
        /*
          The symbols the cards draw, by name — inline, for the reason a
          section page's tiles draw theirs inline: the page's sprite is
          assembled from what the *left column* names, and a card on this page
          would lose its picture the day the column changed. A section's is the
          one its own heading draws (`head_icon`), so the card and the page it
          opens are recognised by the same mark; the three instance cards are
          pages this list does not know, so their names are given here.
        */
        tile_icons: Object.fromEntries(
          [...data.sections.map((section) => section.icon), ...INSTANCE_CARD_ICONS]
            .filter((icon) => icon !== '')
            .map((icon) => [icon, renderInlineIcon(icon, 'spr-icon')]),
        ),
      }),
    status,
  });
}

/**
 * The marks on the overview's three instance cards — the version history, the
 * environment and the download. Named here rather than in the template because
 * the template is handed rendered markup, never a name to look up.
 */
const INSTANCE_CARD_ICONS = ['history', 'terminal', 'download'];
