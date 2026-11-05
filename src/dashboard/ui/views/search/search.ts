import type { Request, Response } from 'express';

import type { ConfigCommon } from '../../../configurator/config-page/payloads';
import { DashboardResponder } from '../../../respond';
import type { Note } from '../../../../global-ui/note';
import { DashboardHit } from '../../../search/search';
import { renderInlineIcon } from '../../../../content-reader/icons';
import { escapeHtml, renderTemplate } from '../../../../content-reader/views';

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
  config: ConfigCommon,
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

        hit_icons: Object.fromEntries(
          data.hits
            .map((hit) => hit.icon)
            .filter((icon) => icon !== '')
            .map((icon) => [icon, renderInlineIcon(icon, 'spr-icon')]),
        ),

        no_match_note: {
          level: 'warn',
          html: `Nothing here matches <code>${escapeHtml(data.query)}</code>. Every word has to match something — try one of them on its own.`,
        },

        unsearchable_note: data.settings_searchable ? null : unsearchableNote(config),
      }),
  });
}

/** Says why only pages are searchable, and what the administrator does to search settings again */
function unsearchableNote(config: ConfigCommon): Note {
  const file = `<code>${escapeHtml(config.config_path ?? '')}</code>`;

  if (config.unreadable) {
    return {
      level: 'warn',
      html: `Only pages are searchable, because speicher.md cannot read the configuration file ${file}: ${escapeHtml(config.unreadable)}. To search the settings as well, make sure that the file exists and that speicher.md may read it.`,
    };
  }

  if (config.unparseable && config.config_source === 'database') {
    return {
      level: 'warn',
      html: `Only pages are searchable, because the newest saved configuration is not valid YAML: ${escapeHtml(config.unparseable)}. To search the settings as well, open <a href="/-/config/history">Configuration history</a> and restore the newest version that is valid.`,
    };
  }

  if (config.unparseable) {
    return {
      level: 'warn',
      html: `Only pages are searchable, because the configuration file ${file} is not valid YAML: ${escapeHtml(config.unparseable)}. To search the settings as well, correct the YAML in the file and search again.`,
    };
  }

  return {
    level: 'warn',
    html: `Only pages are searchable, because the configuration file ${file} is empty. To search the settings as well, add the configuration to the file and search again.`,
  };
}
