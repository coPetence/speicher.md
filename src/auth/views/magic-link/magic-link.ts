import type { Request, Response } from 'express';

import { ConfigService } from '../../../config/config.service';
import { pageChrome } from '../../../content-reader/chrome';
import { renderTemplate, sendHtml } from '../../../content-reader/views';
import { providerMarkOf } from '../../../dashboard/configurator/config-form/members';
import { markSprite, renderMarkRef } from '../../../dashboard/ui/provider-marks';
import { renderPage } from '../../../global-ui/global-views/page-layout/page-layout';

/**
 * Sends the email input form for a magic-link provider
 *
 * The same centred block as the picker, with the provider's mark in the heading
 */
export function sendMagicLink(
  req: Request,
  res: Response,
  config: ConfigService,
  providerId: string,
  redirectTo: string,
): void {
  const mark = providerMarkOf(config.provider(providerId)!);
  const body = renderTemplate('auth/views/magic-link', {
    providerId,
    redirectTo,
    mark: renderMarkRef(mark),
    provider: config.providerName(providerId),
  });
  sendHtml(res, (nonce) =>
    renderPage(body, {
      title: 'Sign in',
      nonce,
      sprite: markSprite([mark]),
      ...pageChrome(req, config, { offerSignIn: false }),
    }),
  );
}
