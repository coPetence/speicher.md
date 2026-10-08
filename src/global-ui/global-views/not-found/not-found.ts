import type { Request, Response } from 'express';

import { ChromeConfig, pageChrome } from '../../../content-reader/chrome';
import { emptyStateArt } from '../../../content-reader/empty-state';
import { renderTemplate, sendHtml } from '../../../content-reader/views';
import { renderPage } from '../page-layout/page-layout';

/**
 * Renders a 404 page
 *
 * Not a middleware: must be called explicitly
 */
export function sendNotFound(req: Request, res: Response, config: ChromeConfig): void {
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
