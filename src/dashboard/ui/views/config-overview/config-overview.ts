import type { Request, Response } from 'express';

import { ConfigOverviewPayload } from '../../../configurator/config-page/payloads';
import { DashboardResponder } from '../../../respond';
import { renderInlineIcon } from '../../../../content-reader/icons';
import { escapeHtml, renderTemplate } from '../../../../content-reader/views';
import { brokenVersionsDialog, loadNotes, versionNotes } from '../../config-notes';
import { ENVIRONMENT_BLURB, HISTORY_BLURB } from '../../instance-blurbs';

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
    overlay: brokenVersionsDialog,
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
        history_blurb: HISTORY_BLURB,
        environment_blurb: ENVIRONMENT_BLURB,
        tile_icons: Object.fromEntries(
          [...data.sections.map((section) => section.icon), ...INSTANCE_CARD_ICONS]
            .filter((icon) => icon !== '')
            .map((icon) => [icon, renderInlineIcon(icon, 'spr-icon')]),
        ),
        page_arrow: renderInlineIcon('chevron-right', 'spr-icon spr-tile-arrow'),
        notes: [
          ...(data.config_source === 'database'
            ? []
            : [
                {
                  level: 'idle',
                  html: `This instance takes its configuration from <code>${escapeHtml(data.config_path || 'inline')}</code>. The file is authoritative, so the settings are read-only here.`,
                },
              ]),
          ...loadNotes(data),
          ...versionNotes(data),
        ],
      }),
    status,
  });
}

const INSTANCE_CARD_ICONS = ['history', 'terminal'];
