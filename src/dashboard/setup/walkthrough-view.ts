import type { Request, Response } from 'express';

import { env } from '../../common/env';
import type { ColourScheme } from '../../config/palette';
import { islandUrl } from '../../content-reader/assets.controller';
import { renderInlineIcon } from '../../content-reader/icons';
import { readerScheme, THEME_COOKIE } from '../../content-reader/views';
import { guidedThroughSetup } from '../respond';
import { renderInlineMark } from '../ui/provider-marks';
import { SYNCING_ICON } from '../ui/views/sync-status/repo-status/repo-status';
import { QUEUED_ICON } from '../ui/views/sync-status/status-overview/status-overview';
import { Walkthrough, walkthroughCookie, walkthroughOf } from './walkthroughs';

// How long a walkthrough that opened by itself stays shut on later visits
const WALKTHROUGH_SEEN_MS = 365 * 24 * 60 * 60 * 1000;

/** What the walkthrough component draws a page's walkthrough with */
export interface WalkthroughView {
  walkthrough: Walkthrough;
  open: boolean;
  icons: Record<string, unknown>;
  screenshots: Record<string, { src: string; dark: string | null } | null>;
}

/**
 * walkthroughView returns the walkthrough of a page, or null when the page has none. It opens by itself the first
 * time the guided setup reaches the page, and sets the cookie that keeps it shut after.
 *
 * @param req the request of the page
 * @param res the response, which carries the cookie
 * @param id the walkthrough's id, e.g. `groups`
 */
export function walkthroughView(req: Request, res: Response, id: string): WalkthroughView | null {
  const walkthrough = walkthroughOf(id);
  if (!walkthrough) return null;
  const cookie = walkthroughCookie(walkthrough);
  const open =
    guidedThroughSetup(req) &&
    req.cookies?.[cookie] === undefined &&
    Object.keys(req.query).length === 0;
  if (open) {
    res.cookie(cookie, '1', {
      httpOnly: true,
      secure: !env('SPEICHER_INSECURE_COOKIES'),
      sameSite: 'lax',
      path: '/',
      maxAge: WALKTHROUGH_SEEN_MS,
    });
  }
  return {
    walkthrough,
    open,
    icons: {
      help: renderInlineIcon('circle-help', 'spr-icon'),
      users: renderInlineIcon('users', 'spr-icon'),
      mail: renderInlineIcon('mail', 'spr-icon'),
      chevron: renderInlineIcon('chevron-right', 'spr-icon'),
      chevron_down: renderInlineIcon('chevron-down', 'spr-icon'),
      arrow_down: renderInlineIcon('arrow-down', 'spr-icon'),
      external: renderInlineIcon('external-link', 'spr-icon'),
      // As on the sync status page
      queued: renderInlineIcon(QUEUED_ICON, 'spr-icon'),
      syncing: renderInlineIcon(SYNCING_ICON, 'spr-icon spr-spin'),
      github: renderInlineMark('github', 'spr-icon'),
      marks: Object.fromEntries(
        ['github', 'git', 'microsoft', 'openid', 'mail'].map((mark) => [
          mark,
          renderInlineMark(mark, 'spr-icon spr-signin-mark'),
        ]),
      ),
      arrow: renderInlineIcon('arrow-right', 'spr-icon'),
    },
    screenshots: {
      install_github_app: screenshot(
        'install-github-app',
        readerScheme(req.cookies?.[THEME_COOKIE]),
      ),
    },
  };
}

/**
 * screenshot returns the URLs of a walkthrough screenshot. It returns null when the client build has none.
 * A fixed scheme gets only its own image. Without one, the browser picks the image by the system scheme.
 *
 * @param name the screenshot's file name in the walkthrough's images, without `-light.webp` or `-dark.webp`
 * @param scheme the scheme the reader fixed, or null to follow the system
 */
function screenshot(
  name: string,
  scheme: ColourScheme | null,
): { src: string; dark: string | null } | null {
  const light = islandUrl(`walkthrough-${name}-light`);
  const dark = islandUrl(`walkthrough-${name}-dark`);
  if (scheme === 'dark') return dark ? { src: dark, dark: null } : null;
  if (scheme === 'light') return light ? { src: light, dark: null } : null;
  return light ? { src: light, dark } : null;
}
