import type { Request, Response } from 'express';

import { ConfigService } from '../config/config.service';
import { dashboardStylesheetUrl, islandUrl } from '../content-reader/assets.controller';
import { ChromeConfig, pageChrome } from '../content-reader/chrome';
import { renderSprite } from '../content-reader/icons';
import { sendHtml } from '../content-reader/views';
import { dashboardNav } from './ui/views/nav-tree/nav-tree';
import { renderSetupProgress } from './ui/views/setup/setup-progress/setup-progress';
import { renderPage } from '../global-ui/global-views/page-layout/page-layout';
import { NOTE_ICON_NAMES } from '../global-ui/note';
import { sendNotFound } from '../global-ui/global-views/not-found/not-found';
import { SetupStep, setupSteps } from './setup/steps';
import {
  DASHBOARD_FOLDS_COOKIE,
  DashboardNavOptions,
  DashboardSection,
  openDashboardFolds,
} from './dashboard-sections';

/**
 * Shared way to answer admin requests
 *
 * An DashboardAnswer is served as JSON to clients that ask
 * for it, and as a full HTML page otherwise, with the
 * sidebar and setup progress bar attached
 *
 * All admin routes render through this so accept
 * negotiation and page chrome stay the same everywhere
 */
export interface DashboardAnswer<T> {
  section: DashboardSection; // Nav section marked as current

  subsection?: string; // Config nav leaf marked as current
  title: string;

  payload: T; // JSON response body and page template data

  page: (payload: T) => string; // Renders the page body from the payload

  status?: number; // HTTP status; 200 when unset

  embedsFrames?: boolean; // Allow the page to be embedded in a frame

  listsSetupSteps?: boolean; // Page shows the steps, so skip the progress bar

  island?: string; // Interactive component to mount on the page

  searchQuery?: string; // Text shown in the sidebar search box
}

export function dashboardNavOptions(config: ConfigService): DashboardNavOptions {
  return {
    showSetup: !config.hasAdministrator,
    hasContent: config.hasContentSource, // Content sections need a source

    // Mail becomes reachable once it is configured or a magic-link provider needs it
    showMailTransport: config.hasMagicLinkProvider || config.hasMailTransport,
  };
}

export class DashboardResponder {
  constructor(private readonly config: ConfigService) {}

  /**
   * Answer an admin request: JSON to clients that prefer it, an HTML page otherwise
   */
  send<T>(req: Request, res: Response, isAdmin: boolean, answer: DashboardAnswer<T>): void {
    const status = answer.status ?? 200;
    if (wantsJson(req)) {
      // JSON varies on Accept and must not be cached
      res.setHeader('Vary', 'Accept');
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(status).json(answer.payload);
      return;
    }
    sendHtml(
      res,
      (nonce) =>
        renderDashboardPage(req, this.config, {
          section: answer.section,
          subsection: answer.subsection,

          ...dashboardNavOptions(this.config),

          progress:
            req.caller?.viaSetup === true && answer.listsSetupSteps !== true
              ? // The setup wizard's own pages list the steps, so they opt out
                setupSteps(this.config, req.path)
              : undefined,
          title: answer.title,
          searchQuery: answer.searchQuery,
          body: answer.page(answer.payload),
          isAdmin,
          nonce,
          island: answer.island,
        }),
      { status, varyAccept: true, embedsFrames: answer.embedsFrames },
    );
  }

  /**
   * The 404 page admin routes answer when the caller may not open them
   */
  notFound(req: Request, res: Response): void {
    sendNotFound(req, res, this.config);
  }
}

export function wantsJson(req: Request): boolean {
  return req.accepts(['html', 'json']) === 'json';
}

/** The admin page shell: nav column, optional setup rail, then the page body */
export function renderDashboardPage(
  req: Request,
  config: ChromeConfig,
  page: {
    section: DashboardSection;
    subsection?: string;
    title: string;
    body: string;
    isAdmin: boolean;
    nonce: string;

    island?: string; // Island the body hydrates, resolved through islandUrl

    showSetup?: boolean; // First run drops the nav search box

    hasContent?: boolean; // False hides the reports until a source exists

    progress?: SetupStep[]; // First-run step rail, drawn in the header beside the brand

    searchQuery?: string; // Prefills the nav search box
  },
): string {
  const nav = dashboardNav(page.section, page.isAdmin, {
    subsection: page.subsection,
    showSetup: page.showSetup,
    hasContent: page.hasContent,
    openFolds: openDashboardFolds(req.cookies?.[DASHBOARD_FOLDS_COOKIE]),
    // The search box tops the column, but not during the first run
    searchQuery: page.isAdmin && page.showSetup !== true ? (page.searchQuery ?? '') : undefined,
  });
  const progress = page.progress ? renderSetupProgress(page.progress) : { html: '', icons: [] };

  return renderPage(page.body, {
    title: `${page.title} - Speicher`,
    nonce: page.nonce,

    nav: nav.html,

    progressBar: progress.html,

    // One sprite carries what nav and rail actually drew, and every note icon: an
    // island can turn any note to any level after the page has loaded
    sprite: renderSprite([...nav.icons, ...progress.icons, ...NOTE_ICON_NAMES]),

    // Admin chrome layers its own stylesheet over the reader's
    extraStylesheet: dashboardStylesheetUrl(),

    // A page with no island of its own still gets the column's slide; the islands
    // that exist bundle the same slide, and a page carries one script either way
    island: islandUrl(page.island ?? 'fold'),

    // The themed reader chrome is off on admin pages
    ...pageChrome(req, config, { themed: false }),

    // in the setup we do not need the search bar
    ...(page.showSetup === true ? { search: false } : {}),

    // No attribution footer on admin pages
    attribution: false,
  });
}
