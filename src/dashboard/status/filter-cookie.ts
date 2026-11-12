/**
 * Cookie remembering the status page's filter
 */
import type { CookieOptions, Request, Response } from 'express';

import { secureCookies } from '../../common/secure-cookies';
import { RepoFilter, repoFilterFromQuery, repoFilterQuery } from './repo-filter';

export const STATUS_FILTER_COOKIE = 'speicher_status_filter';

function filterCookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    secure: secureCookies(req),
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
  res.cookie(STATUS_FILTER_COOKIE, value, filterCookieOptions(req));
}
