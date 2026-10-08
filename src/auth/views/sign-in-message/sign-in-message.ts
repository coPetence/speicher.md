import type { Request, Response } from 'express';

import { ConfigService } from '../../../config/config.service';
import { pageChrome } from '../../../content-reader/chrome';
import { renderTemplate, sendHtml } from '../../../content-reader/views';
import { renderPage } from '../../../global-ui/global-views/page-layout/page-layout';

/**
 * Sends a one-sentence answer from a sign-in flow, in the picker's own block
 *
 * Every refusal in these flows is this page: a flow that cannot continue says so
 * where the reader was already looking, rather than in the reader's 404
 */
export function sendSignInMessage(
  req: Request,
  res: Response,
  config: ConfigService,
  status: number,
  message: string,
): void {
  const body = renderTemplate('auth/views/sign-in-message', { message });
  sendHtml(
    res,
    (nonce) =>
      renderPage(body, {
        title: 'Sign in',
        nonce,
        ...pageChrome(req, config, { offerSignIn: false }),
      }),
    { status },
  );
}
