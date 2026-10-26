import type { Request, Response } from 'express';

import { env } from '../common/env';
import { mintToken } from './tokens';

export const BROWSER_BINDING_COOKIE = 'speicher_binding';

/**
 * Return the browser's binding value, setting the cookie when it has none
 *
 * A magic link is bound to it so the link only works in the browser that started the request
 */
export function bindBrowser(req: Request, res: Response): string {
  const existing = req.cookies?.[BROWSER_BINDING_COOKIE];
  if (typeof existing === 'string' && existing) return existing;

  const binding = mintToken(16);
  res.cookie(BROWSER_BINDING_COOKIE, binding, {
    httpOnly: true,
    secure: !env('SPEICHER_INSECURE_COOKIES'),
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60_000,
  });
  return binding;
}
