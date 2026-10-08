/**
 * Cookie holding the upload claim token
 *
 * The claim mechanism uses a cookie to link uploader to their uploads
 * so that no API key is needed for short-lived upload sessions
 *
 * Not set to `strict` same-site: the uploader may be redirected from the upload
 * origin, and the cookie needs to survive that cross-origin navigation
 */
import type { CookieOptions } from 'express';

import { env } from '../../common/env';
import { CLAIM_TTL_MS } from './setup.service';

export const CLAIM_COOKIE = 'speicher_claim';

export function claimCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: !env('SPEICHER_INSECURE_COOKIES'),
    sameSite: 'lax',
    path: '/',
    maxAge: CLAIM_TTL_MS,
  };
}
