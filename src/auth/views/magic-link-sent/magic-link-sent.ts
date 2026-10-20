import type { Request, Response } from 'express';

import { ConfigService } from '../../../config/config.service';
import { pageChrome } from '../../../content-reader/chrome';
import { renderTemplate, sendHtml } from '../../../content-reader/views';
import { renderPage } from '../../../global-ui/global-views/page-layout/page-layout';

export function sendMagicLinkSent(
  req: Request,
  res: Response,
  config: ConfigService,
  email: string,
  redirectTo: string,
): void {
  const body = renderTemplate('auth/views/magic-link-sent', {
    email,
    otherAddressHref: `/api/auth/login?redirect_to=${encodeURIComponent(redirectTo)}`,
  });
  sendHtml(res, (nonce) =>
    renderPage(body, {
      title: 'Check your email',
      nonce,
      ...pageChrome(req, config, { offerSignIn: false }),
    }),
  );
}
