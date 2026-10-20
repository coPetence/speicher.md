import type { Request, Response } from 'express';

import { env } from '../../../common/env';
import { ConfigService } from '../../../config/config.service';
import { providerType } from '../../../config/types';
import { pageChrome } from '../../../content-reader/chrome';
import { renderTemplate, sendHtml } from '../../../content-reader/views';
import { providerMarkOf } from '../../../dashboard/configurator/config-form/members';
import { markSprite, renderMarkRef } from '../../../dashboard/ui/provider-marks';
import { renderPage } from '../../../global-ui/global-views/page-layout/page-layout';
import { catchAllProviders, hasRoutedProvider } from '../../sign-in-routing';

export interface SignInPageOptions {
  notice?: string;
  email?: string;
  formActions?: string[];
}

interface SignInOption {
  name: string;
  mark: string;
  href?: string;
  provider: string;
}

export function sendSignIn(
  req: Request,
  res: Response,
  config: ConfigService,
  redirectTo: string,
  options: SignInPageOptions = {},
): void {
  const { notice, email = '', formActions = [] } = options;
  const buttons = catchAllProviders(config).filter(
    (id) => providerType(config.provider(id)!) !== 'magic-link',
  );
  const askEmail = hasRoutedProvider(config) || config.hasMagicLinkProvider;
  sendPage(req, res, config, {
    notice,
    redirectTo,
    askEmail,
    email,
    devLogin: env('SPEICHER_DEV_LOGIN'),
    options: buttons.map((id) => ({
      ...optionOf(config, id),
      href: `/api/auth/login?provider=${encodeURIComponent(id)}&redirect_to=${encodeURIComponent(redirectTo)}`,
    })),
    formActions,
  });
}

export function sendProviderChoice(
  req: Request,
  res: Response,
  config: ConfigService,
  providerIds: string[],
  email: string,
  redirectTo: string,
  formActions: string[] = [],
): void {
  sendPage(req, res, config, {
    notice: `Choose how to sign in as ${email}.`,
    redirectTo,
    askEmail: false,
    email,
    devLogin: false,
    otherAddressHref: `/api/auth/login?redirect_to=${encodeURIComponent(redirectTo)}`,
    options: providerIds.map((id) => optionOf(config, id)),
    formActions,
  });
}

function optionOf(config: ConfigService, id: string): SignInOption {
  return {
    provider: id,
    name: config.providerName(id),
    mark: renderMarkRef(providerMarkOf(config.provider(id)!), 'spr-icon spr-signin-mark'),
  };
}

function sendPage(
  req: Request,
  res: Response,
  config: ConfigService,
  model: {
    notice?: string;
    redirectTo: string;
    askEmail: boolean;
    email: string;
    devLogin: unknown;
    otherAddressHref?: string;
    options: SignInOption[];
    formActions: string[];
  },
): void {
  const { formActions, ...view } = model;
  const marks = view.options.map((option) => providerMarkOf(config.provider(option.provider)!));
  const body = renderTemplate('auth/views/sign-in', view);
  sendHtml(
    res,
    (nonce) =>
      renderPage(body, {
        title: 'Sign in',
        nonce,
        sprite: markSprite(marks),
        ...pageChrome(req, config, { offerSignIn: false }),
      }),
    { formActions: [...new Set(formActions)] },
  );
}
