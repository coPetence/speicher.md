import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';

import { safeRedirect } from '../auth/oidc.service';
import { env } from '../common/env';
import { THEME_COOKIE, readerScheme } from './views';

const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function cookieOptions(): CookieOptions {
  return {
    // Not saved outside HTTPS to keep the cookie from leaking on dev over HTTP
    httpOnly: true,
    // Not set when SPEICHER_INSECURE_COOKIES is true, which implies HTTP-only dev
    secure: !env('SPEICHER_INSECURE_COOKIES'),
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_MS,
  };
}

/**
 * POST endpoint to toggle a reader's display scheme (light / dark / auto)
 *
 * Accepts `scheme` in the JSON body; valid values are defined by `readerScheme()`
 * Sets or removes the theme cookie, then redirects back to the referer
 */
@Controller('api/appearance')
export class AppearanceController {
  @Post()
  set(@Req() req: Request, @Res() res: Response, @Body() body: { scheme?: unknown }): void {
    // Prevent the redirect from being cached so a subsequent GET shows the new theme
    res.setHeader('Cache-Control', 'no-store');

    const scheme = readerScheme(body?.scheme);
    if (scheme) {
      res.cookie(THEME_COOKIE, scheme, cookieOptions());
    } else {
      // Invalid or missing scheme clears the cookie, falling back to browser default
      res.clearCookie(THEME_COOKIE, { ...cookieOptions(), maxAge: undefined });
    }

    res.redirect(303, backTo(req));
  }
}

function backTo(req: Request): string {
  const referer = req.get('referer');
  if (!referer) return '/';
  try {
    return safeRedirect(new URL(referer).pathname);
  } catch {
    return '/';
  }
}
