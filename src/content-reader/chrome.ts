import type { Request } from 'express';

import { safeRedirect } from '../auth/oidc.service';
import type { ResolvedCaller } from '../authz/caller';
import type { ConfigService } from '../config/config.service';
import type { ColourScheme } from '../config/palette';
import { stylesheetUrl } from './assets.controller';
import { DEFAULT_BRAND_ICON, renderInlineIcon } from './icons';
import { hasTemplateWallpapers, templateWallpaperUrls } from './template-wallpapers';
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
  | 'brandLogoDark'
  | 'brandMark'
  | 'faviconUrl'
  | 'faviconType'
  | 'brandNameShown'
  | 'brandNameAlign'
  | 'searchIcon'
  | 'attribution'
  | 'wallpaper'
>;

export type ChromeConfig = Pick<
  ConfigService,
  | 'themeTemplate'
  | 'themeOverridesFor'
  | 'brand'
  | 'brandLogoUrl'
  | 'brandLogoDarkUrl'
  | 'brandWallpaperUrl'
  | 'brandWallpaperDarkUrl'
  | 'brandWallpaperAllThemes'
  | 'faviconUrl'
  | 'faviconType'
  | 'brandShowName'
  | 'brandNameAlign'
  | 'attribution'
  | 'hasContentSource'
>;

/**
 * Page chrome assembled from request and config
 *
 * Setup callers see no account or sign-in UI
 */
export function pageChrome(
  req: Request,
  config: ChromeConfig,
  options: { offerSignIn?: boolean } = {},
): RouteChrome {
  const scheme = readerScheme(req.cookies?.[THEME_COOKIE]);
  const wallpaper = wallpaperFor(config, config.themeTemplate);

  return {
    scheme,
    stylesheet: stylesheetUrl(config.themeTemplate, scheme),

    // Theme overrides, wallpaper and nav width merged into one <style> block
    themeTokens:
      [
        config.themeOverridesFor(scheme),
        wallpaperTokens(wallpaper.light, wallpaper.dark, scheme),
        navWidthTokens(req.cookies?.[NAV_WIDTH_COOKIE]),
      ]
        .filter((block): block is string => Boolean(block))
        .join('') || null,
    wallpaper: Boolean(wallpaper.light || wallpaper.dark),

    account: req.caller?.viaSetup === true ? null : accountChrome(req.caller),
    brand: config.brand,

    brandLogo: config.brandLogoUrl,
    brandLogoDark: config.brandLogoDarkUrl,
    brandMark: config.brandLogoUrl ? null : brandMark(),

    faviconUrl: config.faviconUrl,
    faviconType: config.faviconType,

    brandNameShown: config.brandLogoUrl ? config.brandShowName : true,
    brandNameAlign: config.brandNameAlign,
    searchIcon: searchIcon(),

    search: config.hasContentSource,
    attribution: config.attribution,

    signInHref:
      options.offerSignIn === false || req.caller?.viaSetup === true ? null : signInHref(req),
  };
}

/**
 * The wallpaper URLs for each scheme
 *
 * An upload replaces the template's wallpaper in its own scheme only
 *
 * @param config the instance config
 * @param template the template the page is drawn in
 */
export function wallpaperFor(
  config: Pick<
    ConfigService,
    'brandWallpaperUrl' | 'brandWallpaperDarkUrl' | 'brandWallpaperAllThemes'
  >,
  template: string,
): { light: string | null; dark: string | null } {
  const own = templateWallpaperUrls(template);
  const uploaded = config.brandWallpaperAllThemes || hasTemplateWallpapers(template);
  const light = uploaded ? config.brandWallpaperUrl : null;
  const dark = uploaded ? config.brandWallpaperDarkUrl : null;
  return {
    light: light ?? own.light,
    dark: dark ?? own.dark ?? light,
  };
}

/**
 * The wallpaper as a `--spr-wallpaper` token for each scheme
 *
 * Dark mode falls back to the light wallpaper, as the logo does
 *
 * @param light URL of the wallpaper for light mode
 * @param dark URL of the wallpaper for dark mode
 * @param scheme the scheme the reader fixed, or null to follow the system
 */
export function wallpaperTokens(
  light: string | null,
  dark: string | null,
  scheme: ColourScheme | null,
): string | null {
  const token = (url: string) => `:root{--spr-wallpaper:url("${url}")}`;
  const forDark = dark ?? light;

  if (scheme === 'light') return light ? token(light) : null;
  if (scheme === 'dark') return forDark ? token(forDark) : null;

  const blocks: string[] = [];
  if (light) blocks.push(`@media (prefers-color-scheme: light){${token(light)}}`);
  if (forDark) blocks.push(`@media (prefers-color-scheme: dark){${token(forDark)}}`);
  return blocks.join('') || null;
}

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
