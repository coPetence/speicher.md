/**
 * Cookie remembering the status page's filter
 */
import type { CookieOptions, Request, Response } from 'express';

import { env } from '../../common/env';
import { RepoFilter, repoFilterFromQuery, repoFilterQuery } from './repo-filter';

export const STATUS_FILTER_COOKIE = 'speicher_status_filter';

function filterCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    // Left off only for local development over plain HTTP
    secure: !env('SPEICHER_INSECURE_COOKIES'),
    sameSite: 'lax',
    path: '/-/status',
    maxAge: 180 * 24 * 60 * 60 * 1000,
  };
}

export function rememberedFilter(req: Request): RepoFilter | null {
  return repoFilterFromQuery(req.cookies?.[STATUS_FILTER_COOKIE] as string | undefined);
}

export function rememberFilter(req: Request, res: Response, filter: RepoFilter): void {
  const value = repoFilterQuery(filter);
  if (value === req.cookies?.[STATUS_FILTER_COOKIE]) return;
  res.cookie(STATUS_FILTER_COOKIE, value, filterCookieOptions());
}
