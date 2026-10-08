/**
 * Renders and sends a 500 error page
 *
 * The page displays a request ID so support can trace the failure in logs
 */
import type { Request, Response } from 'express';

import { ChromeConfig, pageChrome } from '../../../content-reader/chrome';
import { emptyStateArt } from '../../../content-reader/empty-state';
import { renderTemplate, sendHtml } from '../../../content-reader/views';
import { renderPage } from '../page-layout/page-layout';

export function sendServerError(
  req: Request,
  res: Response,
  config: ChromeConfig,
  requestId: string | null,
): void {
  sendHtml(
    res,
    (nonce) =>
      renderPage(
        renderTemplate('global-ui/global-views/server-error', {
          requestId,
          art: emptyStateArt('broken'),
        }),
        {
          title: 'Server Error',
          nonce,
          ...pageChrome(req, config),
        },
      ),
    { status: 500 },
  );
}
