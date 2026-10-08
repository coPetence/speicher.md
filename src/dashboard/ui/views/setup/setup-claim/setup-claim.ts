import type { Request, Response } from 'express';

import { relativeTime } from '../../../../../common/time';
import { ConfigService } from '../../../../../config/config.service';
import { islandUrl, setupStylesheetUrl } from '../../../../../content-reader/assets.controller';
import { pageChrome } from '../../../../../content-reader/chrome';
import { renderInlineIcon } from '../../../../../content-reader/icons';
import { renderTemplate, sendHtml } from '../../../../../content-reader/views';
import { renderPage } from '../../../../../global-ui/global-views/page-layout/page-layout';

/** The claim this browser holds, as the page shows it */
export interface ClaimView {
  code: string;
  origin: string;
  created_at: Date;
}

/** Sends the claim page an unconfigured instance serves at `/` */
export function sendSetupClaim(
  req: Request,
  res: Response,
  config: ConfigService,
  claim: ClaimView,
): void {
  sendHtml(
    res,
    (nonce) =>
      renderPage(
        renderTemplate('dashboard/ui/views/setup/setup-claim', {
          code: claim.code,
          origin: claim.origin,
          age: relativeTime(claim.created_at),
          copyIcon: renderInlineIcon('copy', 'spr-icon'),
          copiedIcon: renderInlineIcon('check', 'spr-icon'),
        }),
        {
          title: 'Claim your instance',
          nonce,
          island: islandUrl('setup'),

          extraStylesheet: setupStylesheetUrl(),
          ...pageChrome(req, config),

          signInHref: null,
        },
      ),
    // The claim is approved from the shell, therefore having a cache would cause the browser to display an outdated state and not redirect to the next setup step.
    { noStore: true },
  );
}
