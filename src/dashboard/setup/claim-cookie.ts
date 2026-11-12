/**
 * Cookie holding the upload claim token
 *
 * The claim mechanism uses a cookie to link uploader to their uploads
 * so that no API key is needed for short-lived upload sessions
 *
 * Not set to `strict` same-site: the uploader may be redirected from the upload
 * origin, and the cookie needs to survive that cross-origin navigation
 */
import type { CookieOptions, Request } from 'express';

import { secureCookies } from '../../common/secure-cookies';
import { CLAIM_TTL_MS } from './setup.service';

export const CLAIM_COOKIE = 'speicher_claim';

export function claimCookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    secure: secureCookies(req),
    sameSite: 'lax',
    path: '/',
    maxAge: CLAIM_TTL_MS,
  };
}
