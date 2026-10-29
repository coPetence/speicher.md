import type { Request, Response } from 'express';

import { ConfigService } from '../config/config.service';
import { dashboardStylesheetUrl, islandUrl } from '../content-reader/assets.controller';
import { ChromeConfig, pageChrome } from '../content-reader/chrome';
import { renderInlineIcon, renderSprite } from '../content-reader/icons';
import { renderComponent, sendHtml } from '../content-reader/views';
import { sendNotFound } from '../global-ui/global-views/not-found/not-found';
import { renderPage } from '../global-ui/global-views/page-layout/page-layout';
import { NOTE_ICON_NAMES } from '../global-ui/note';
import {
  DASHBOARD_FOLDS_COOKIE,
  DashboardNavOptions,
  DashboardSection,
  openDashboardFolds,
} from './dashboard-sections';
import {
  SETUP_LATER_COOKIE,
  SETUP_LATER_PATH,
  SetupStep,
  setupGuide,
  setupSteps,
} from './setup/steps';
import { dashboardNav } from './ui/views/nav-tree/nav-tree';
import { renderSetupProgress } from './ui/views/setup/setup-progress/setup-progress';

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

  overlay?: (payload: T) => string | null;

  status?: number; // HTTP status; 200 when unset

  embedsFrames?: boolean; // Allow the page to be embedded in a frame

  formActions?: string[]; // Outside origins a form on the page may post or redirect to (CSP form-action)

  listsSetupSteps?: boolean; // Page shows the steps, so skip the progress bar

  leadsSetup?: boolean;

  island?: string; // Interactive component to mount on the page

  searchQuery?: string; // Text shown in the sidebar search box
}

export function guidedThroughSetup(req: Request): boolean {
  const caller = req.caller;
  if (caller?.inSetup !== true) return false;
  return caller.viaSetup === true || req.cookies?.[SETUP_LATER_COOKIE] !== '1';
}

export function dashboardNavOptions(config: ConfigService, guided: boolean): DashboardNavOptions {
  return {
    showSetup: guided,
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
    const guided = guidedThroughSetup(req);
    const steps = guided ? setupSteps(this.config, req.path, req.caller?.readsPage === true) : null;
    sendHtml(
      res,
      (nonce) =>
        renderDashboardPage(req, this.config, {
          section: answer.section,
          subsection: answer.subsection,

          ...dashboardNavOptions(this.config, guided),

          progress: steps && answer.listsSetupSteps !== true ? steps : undefined,
          guide: guideBar(req, steps, answer.leadsSetup === true),
          title: answer.title,
          searchQuery: answer.searchQuery,
          body: answer.page(answer.payload),
          overlay: answer.overlay?.(answer.payload) ?? null,
          isAdmin,
          nonce,
          island: answer.island,
        }),
      {
        status,
        varyAccept: true,
        embedsFrames: answer.embedsFrames,
        formActions: answer.formActions,
      },
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

/**
 * guideBar returns the setup's bar at the foot of the page, or an empty string outside the setup.
 *
 * @param req the request
 * @param steps the steps of the setup while it is guided, or null when it is not
 * @param leads whether the page has its own button on through the setup
 */
function guideBar(req: Request, steps: SetupStep[] | null, leads: boolean): string {
  const arrowIcon = renderInlineIcon('arrow-right', 'spr-icon');
  if (!steps) {
    return req.caller?.inSetup === true
      ? renderComponent('@setup-guide', { deferred: true, arrowIcon })
      : '';
  }
  if (leads) return '';
  return renderComponent('@setup-guide', {
    deferred: false,
    guide: setupGuide(steps),
    laterHref: req.caller?.viaSetup === true ? null : SETUP_LATER_PATH,
    arrowIcon,
  });
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
    overlay?: string | null;
    isAdmin: boolean;
    nonce: string;

    island?: string; // Island the body hydrates, resolved through islandUrl

    showSetup?: boolean; // First run drops the nav search box

    hasContent?: boolean; // False hides the reports until a source exists

    progress?: SetupStep[]; // First-run step rail, drawn in the header beside the brand

    guide?: string; // The setup's bar at the foot of the pane

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

    guideBar: page.guide ?? '',

    // One sprite carries what nav and rail actually drew, and every note icon: an
    // island can turn any note to any level after the page has loaded
    sprite: renderSprite([...nav.icons, ...progress.icons, ...NOTE_ICON_NAMES]),

    // Admin chrome layers its own stylesheet over the reader's
    extraStylesheet: dashboardStylesheetUrl(),

    // A page with no island of its own still gets the column's slide; the islands
    // that exist bundle the same slide, and a page carries one script either way
    island: islandUrl(page.island ?? 'fold'),

    ...pageChrome(req, config),

    // in the setup we do not need the search bar
    ...(page.showSetup === true ? { search: false } : {}),

    // No attribution footer on admin pages
    attribution: false,

    overlay: page.overlay,
  });
}
