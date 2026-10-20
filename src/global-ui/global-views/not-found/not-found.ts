import type { Request, Response } from 'express';

import { safeRedirect } from '../../../auth/oidc.service';
import type { ConfigService } from '../../../config/config.service';
import { ChromeConfig, pageChrome } from '../../../content-reader/chrome';
import { emptyStateArt } from '../../../content-reader/empty-state';
import { isFragmentRequest, renderTemplate, sendHtml } from '../../../content-reader/views';
import { renderPage } from '../page-layout/page-layout';

/** The config a 404 page reads: its chrome, and whether there is a provider to sign in with */
export type NotFoundConfig = ChromeConfig & Pick<ConfigService, 'providerShortIds'>;

/**
 * Renders a 404 page
 *
 * A signed-out browser is sent to sign in instead, whether the page is missing or
 * hidden from them, so the redirect tells nothing about which pages exist
 *
 * Not a middleware: must be called explicitly
 */
export function sendNotFound(req: Request, res: Response, config: NotFoundConfig): void {
  if (redirectToSignIn(req, res, config)) return;
  sendHtml(
    res,
    (nonce) =>
      renderPage(
        renderTemplate('global-ui/global-views/not-found', {
          authenticated: req.caller?.identity != null,
          art: emptyStateArt('missing'),
        }),
        {
          title: 'Page not found',
          nonce,
          ...pageChrome(req, config),
        },
      ),
    { status: 404 },
  );
}

/**
 * redirectToSignIn sends a signed-out browser to the sign-in page, coming back to the
 * page it asked for. It returns false, sending nothing, for any other request.
 *
 * @param req the request
 * @param res the response
 * @param config the instance config
 */
export function redirectToSignIn(req: Request, res: Response, config: NotFoundConfig): boolean {
  if (!sendsToSignIn(req, config)) return false;
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Accept, Cookie');
  res.redirect(
    302,
    `/api/auth/login?redirect_to=${encodeURIComponent(safeRedirect(req.originalUrl))}`,
  );
  return true;
}

/**
 * True for a signed-out browser opening a page on an instance that has a provider
 *
 * Only a navigation that asks for HTML: API calls, assets and the tree island's
 * fragments keep their 404
 */
function sendsToSignIn(req: Request, config: NotFoundConfig): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.caller?.identity != null || req.caller?.viaSetup === true) return false;
  if (isFragmentRequest(req)) return false;
  if (req.path.startsWith('/api/')) return false;
  if (!(req.headers.accept ?? '').includes('text/html')) return false;
  return config.providerShortIds.length > 0;
}
