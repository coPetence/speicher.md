import type { Request, Response } from 'express';

import { env } from '../../../common/env';
import { ConfigService } from '../../../config/config.service';
import { pageChrome } from '../../../content-reader/chrome';
import { renderTemplate, sendHtml } from '../../../content-reader/views';
import { providerMarkOf } from '../../../dashboard/configurator/config-form/members';
import { markSprite, renderMarkRef } from '../../../dashboard/ui/provider-marks';
import { renderPage } from '../../../global-ui/global-views/page-layout/page-layout';

export function sendSignIn(
  req: Request,
  res: Response,
  config: ConfigService,
  redirectTo: string,
  notice?: string,
): void {
  const marks = config.providerShortIds.map((id) => providerMarkOf(config.provider(id)!));
  const body = renderTemplate('auth/views/sign-in', {
    notice,
    redirectTo,
    devLogin: env('SPEICHER_DEV_LOGIN'),
    options: config.providerShortIds.map((id, index) => ({
      href: `/api/auth/login?provider=${encodeURIComponent(id)}&redirect_to=${encodeURIComponent(redirectTo)}`,
      mark: renderMarkRef(marks[index], 'spr-icon spr-signin-mark'),
      name: config.providerName(id),
    })),
  });
  sendHtml(res, (nonce) =>
    renderPage(body, {
      title: 'Sign in',
      nonce,
      sprite: markSprite(marks),
      ...pageChrome(req, config, { offerSignIn: false }),
    }),
  );
}
