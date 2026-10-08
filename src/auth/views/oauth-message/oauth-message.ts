import type { Request, Response } from 'express';

import { ConfigService } from '../../../config/config.service';
import { pageChrome } from '../../../content-reader/chrome';
import { renderTemplate, sendHtml } from '../../../content-reader/views';
import { renderPage } from '../../../global-ui/global-views/page-layout/page-layout';

/**
 * Sends a one-sentence answer from the OAuth flow
 *
 * Nothing is redirected anywhere until `redirect_uri` has been matched against
 * the client's own document, so before that an error is this page: an OAuth
 * error code carried to an unvalidated URI is an open redirector
 */
export function sendOauthMessage(
  req: Request,
  res: Response,
  config: ConfigService,
  status: number,
  message: string,
): void {
  const body = renderTemplate('auth/views/oauth-message', { message });
  sendHtml(
    res,
    (nonce) =>
      renderPage(body, {
        title: 'Connect an application',
        nonce,
        ...pageChrome(req, config, { offerSignIn: false }),
      }),
    { status },
  );
}
