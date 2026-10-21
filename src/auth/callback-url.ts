import type { Request } from 'express';

import { env } from '../common/env';

/** Where an OIDC provider returns a reader after the sign-in */
export const OIDC_CALLBACK_PATH = '/api/auth/callback';

/** Where GitHub returns a reader after they authorise the sign-in */
export const GITHUB_CALLBACK_PATH = '/api/auth/github/callback';

export function publicUrl(): string | null {
  const declared = env('SPEICHER_PUBLIC_URL');
  if (!declared) return null;

  const base = declared.replace(/\/+$/, '');
  return base === '' ? null : base;
}

/**
 * Origin for callback URLs and magic links
 */
export function originOf(req: Request): string {
  return publicUrl() ?? `${req.protocol}://${req.get('host')}`;
}

/**
 * Absolute callback URL a sign-in of this kind returns to
 */
export function callbackUrl(req: Request, kind: 'oidc' | 'github'): string {
  return `${originOf(req)}${kind === 'github' ? GITHUB_CALLBACK_PATH : OIDC_CALLBACK_PATH}`;
}

/** Absolute callback URL, or null when the public address is not declared */
export function githubCallbackUrl(): string | null {
  const base = publicUrl();
  return base === null ? null : `${base}${GITHUB_CALLBACK_PATH}`;
}
