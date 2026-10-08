import type { Request } from 'express';

import { safeRedirect } from '../auth/oidc.service';
import type { ResolvedCaller } from '../authz/caller';
import type { ConfigService } from '../config/config.service';
import { DEFAULT_TEMPLATE, stylesheetUrl } from './assets.controller';
import { renderInlineIcon } from './icons';
import { NAV_WIDTH_COOKIE, THEME_COOKIE, navWidthTokens, readerScheme } from './views';
import {
  AccountChrome,
  AccountMenuIcons,
  PageChrome,
} from '../global-ui/global-views/page-layout/page-layout';

/** Route handlers build this from cookies and config for the layout template */
export type RouteChrome = Pick<
  PageChrome,
  | 'stylesheet'
  | 'themeTokens'
  | 'scheme'
  | 'account'
  | 'signInHref'
  | 'search'
  | 'brand'
  | 'brandLogo'
  | 'brandMark'
  | 'brandNameShown'
  | 'searchIcon'
  | 'attribution'
>;

export type ChromeConfig = Pick<
  ConfigService,
  | 'themeTemplate'
  | 'themeOverridesFor'
  | 'brand'
  | 'brandLogoUrl'
  | 'brandShowName'
  | 'attribution'
  | 'hasContentSource'
>;

/**
 * Page chrome assembled from request and config
 *
 * Not themed for config-editor and setup routes
 * Setup callers see no account or sign-in UI
 */
export function pageChrome(
  req: Request,
  config: ChromeConfig,
  options: { offerSignIn?: boolean; themed?: boolean } = {},
): RouteChrome {
  const themed = options.themed !== false;

  const scheme = readerScheme(req.cookies?.[THEME_COOKIE]);

  return {
    scheme,
    stylesheet: stylesheetUrl(themed ? config.themeTemplate : DEFAULT_TEMPLATE, scheme),

    // Theme overrides and nav width merged into one <style> block
    themeTokens:
      [
        themed ? config.themeOverridesFor(scheme) : null,
        navWidthTokens(req.cookies?.[NAV_WIDTH_COOKIE]),
      ]
        .filter((block): block is string => Boolean(block))
        .join('') || null,

    account: req.caller?.viaSetup === true ? null : accountChrome(req.caller),
    brand: config.brand,

    brandLogo: config.brandLogoUrl,
    brandMark: config.brandLogoUrl ? null : brandMark(),

    brandNameShown: config.brandLogoUrl ? config.brandShowName : true,
    searchIcon: searchIcon(),

    search: config.hasContentSource,
    attribution: config.attribution,

    signInHref:
      options.offerSignIn === false || req.caller?.viaSetup === true ? null : signInHref(req),
  };
}

export const DEFAULT_BRAND_ICON = 'library';

export function brandMark(): string {
  return renderInlineIcon(DEFAULT_BRAND_ICON, 'spr-brand-mark');
}

export function searchIcon(): string {
  return renderInlineIcon('search', 'spr-icon');
}

/**
 * Names of the marks beside the account menu's three items
 *
 * `plug` is the Connections section's own icon in the left nav, so the one entry
 * point a reader has to that page carries the mark the page wears. The other two
 * name the place or the action rather than a section: the admin link lands on
 * sync status but offers the whole dashboard, so it wears the dashboard's mark and
 * not that page's, and `log-out` is the one glyph a reader reads without a word
 * beside it.
 */
const ACCOUNT_MENU_ICONS: Readonly<Record<keyof AccountMenuIcons, string>> = {
  dashboard: 'layout-dashboard',
  connections: 'plug',
  signOut: 'log-out',
};

/** Rendered once per process: the marks are the same on every page */
let accountMenuIcons: AccountMenuIcons | null = null;

function accountIcons(): AccountMenuIcons {
  accountMenuIcons ??= {
    dashboard: renderInlineIcon(ACCOUNT_MENU_ICONS.dashboard, 'spr-icon'),
    connections: renderInlineIcon(ACCOUNT_MENU_ICONS.connections, 'spr-icon'),
    signOut: renderInlineIcon(ACCOUNT_MENU_ICONS.signOut, 'spr-icon'),
  };
  return accountMenuIcons;
}

/**
 * Account widget data for the page header
 *
 * Null for anonymous callers, those without an identity, or bearer-token callers
 */
export function accountChrome(caller: ResolvedCaller | undefined): AccountChrome | null {
  if (!caller || !caller.identity || caller.viaBearer) return null;

  const identity = caller.identity;

  const name = identity.displayName?.trim() || identity.email || identity.subject;
  return {
    name,
    initials: initialsOf(name),
    email: identity.email,
    isAdmin: caller.isAdmin,
    icons: accountIcons(),
  };
}

/**
 * Two-letter initials from a name or email
 *
 * Strips email domain, takes first char of first and last alphanumeric word
 * Falls back to `?` for empty result
 */
export function initialsOf(name: string): string {
  const at = name.indexOf('@');
  const local = at > 0 ? name.slice(0, at) : name;
  const words = local.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...words[0]][0] ?? '';
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? '') : '';
  return (first + last).toLocaleUpperCase();
}

export function signInHref(req: Request): string {
  return `/api/auth/login?redirect_to=${encodeURIComponent(safeRedirect(req.path))}`;
}
