import type { Request, Response } from 'express';

import { safeRedirect } from '../../../auth/oidc.service';
import type { ConfigService } from '../../../config/config.service';
import { ChromeConfig, pageChrome } from '../../../content-reader/chrome';
import { emptyStateArt } from '../../../content-reader/empty-state';
import { isFragmentRequest, renderTemplate, sendHtml } from '../../../content-reader/views';
import { renderPage } from '../page-layout/page-layout';

export type NotFoundConfig = ChromeConfig & Pick<ConfigService, 'providerShortIds'>;

/**
 * Renders a 404 page
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
 * redirectToSignIn sends a signed-out browser to the sign-in page
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
 * True for a signed-out browser opening a page on an instance with a configured provider
 */
function sendsToSignIn(req: Request, config: NotFoundConfig): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.caller?.identity != null || req.caller?.viaSetup === true) return false;
  if (isFragmentRequest(req)) return false;
  if (req.path.startsWith('/api/')) return false;
  if (!(req.headers.accept ?? '').includes('text/html')) return false;
  return config.providerShortIds.length > 0;
}
