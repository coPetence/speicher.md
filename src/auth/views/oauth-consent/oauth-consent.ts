import type { Request, Response } from 'express';

import { ConfigService } from '../../../config/config.service';
import { pageChrome } from '../../../content-reader/chrome';
import { renderTemplate, sendHtml } from '../../../content-reader/views';
import { renderPage } from '../../../global-ui/global-views/page-layout/page-layout';

/* The authorization request's own parameters, carried across the consent post */
const CARRIED_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource',
];

export function sendOauthConsent(
  req: Request,
  res: Response,
  config: ConfigService,
  name: string,
  params: Record<string, string>,
  redirectUri: string,
): void {
  const body = renderTemplate('auth/views/oauth-consent', {
    name,
    host: hostOf(params.redirect_uri),
    hidden: CARRIED_PARAMS.filter(
      (key) => typeof params[key] === 'string' && params[key] !== '',
    ).map((key) => ({ name: key, value: params[key] })),
  });
  sendHtml(
    res,
    (nonce) =>
      renderPage(body, {
        title: 'Connect an application',
        nonce,
        ...pageChrome(req, config, { offerSignIn: false }),
      }),
    { formActions: [new URL(redirectUri).origin] },
  );
}

function hostOf(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}
