/**
 * HTML page rendering for the reader
 *
 * Templates come from the views directory, cached in production and auto-escaped
 * Nonce-based CSP, so each response minted a fresh nonce via sendHtml
 * Fragments are the partial pages the tree island fetches over x-speicher-fragment
 *
 * Not fetched on hover to avoid a round trip
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { Eta } from 'eta';
import type { Request, Response } from 'express';

import { reflectsCallerInput } from '../app-setup';
import { env, isProduction } from '../common/env';
import type { ColourScheme } from '../config/palette';

// Views live beside the surface that sends them — `content-reader/views`, `dashboard/ui/views`,
// `auth/views` and `global-ui/global-views` — so a view's name is its folder's path from the
// source root, and says where it lives
const VIEW_DIR = join(__dirname, '..');

const eta = new Eta({
  views: VIEW_DIR,
  cache: isProduction(),
  autoEscape: true,
  autoTrim: false,
});

/** Every view is a folder holding `<name>.eta`, so `dashboard/ui/views/sync-status/logs` is `src/dashboard/ui/views/sync-status/logs/logs.eta` */
function templateSource(name: string): string {
  return readFileSync(join(VIEW_DIR, name, `${basename(name)}.eta`), 'utf8');
}

/** Per-response nonce for inline styles and scripts under the CSP */
function newNonce(): string {
  return randomBytes(16).toString('base64');
}

const COMPONENT_DIR = join(__dirname, '../global-ui/components');

/*
  Each component is a folder holding `<name>.eta` and, where it has styles of its
  own, `<name>.css`. The template is registered as a named template (`@field`)
  rather than resolved as a file: Eta's `include` refuses a path outside `views`,
  and `renderTemplate` compiles from a string, so a relative include has no file
  to be relative to. Outside production they are re-read on every render, as
  views are.
*/
let componentsLoaded = false;

/** Renders an .eta template: HTML-escaped, auto-trim disabled */
export function renderTemplate(name: string, data: Record<string, unknown>): string {
  if (!componentsLoaded || !isProduction()) {
    for (const component of readdirSync(COMPONENT_DIR)) {
      eta.loadTemplate(
        `@${component}`,
        readFileSync(join(COMPONENT_DIR, component, `${component}.eta`), 'utf8'),
      );
    }
    componentsLoaded = true;
  }
  return eta.renderString(templateSource(name), data);
}

export const NAV_WIDTH_COOKIE = 'speicher_nav_width';

/**
 * Turns the reader's dragged tree width into a :root CSS declaration
 * Refuses anything but a bare positive number so a cookie can't inject CSS
 * Clamps to 4096px as the layout's practical ceiling
 */
export function navWidthTokens(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const px = Number(raw);
  if (!Number.isFinite(px) || px <= 0) return null;
  return `:root{--spr-nav-user:${Math.round(Math.min(px, 4096))}px}`;
}

export const THEME_COOKIE = 'speicher_theme';

/** Maps the theme cookie to a palette scheme; anything else is refused */
export function readerScheme(raw: unknown): ColourScheme | null {
  return raw === 'light' || raw === 'dark' ? raw : null;
}

/** Header the tree island sets to ask for a partial page instead of the full layout */
export const FRAGMENT_HEADER = 'x-speicher-fragment';

/** A partial page: navigable content without the layout chrome */
export interface Fragment {
  title: string;

  countable?: boolean;

  html: string;

  symbols: string;

  /**
   * Which repository's tree this content belongs beside — its public base path, the
   * value the full page puts on the shell as `data-spr-tree`. The island swaps only
   * when the two agree: `<main>` changes and the tree does not, so a swap across a
   * repository boundary would leave one repository's tree beside another's page,
   * nothing in it current. A cross-repo link, a related row, a search hit and Back
   * all cross it, which is why this is decided here and not on the link.
   */
  tree: string;
}

/** True when the tree island asked for a fragment rather than a full page */
export function isFragmentRequest(req: Request): boolean {
  return req.headers[FRAGMENT_HEADER] === '1';
}

/** Sends the content pane alone, as JSON the tree island swaps into the open shell */
export function sendFragment(res: Response, fragment: Fragment): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'private, no-store');

  // Required so the frontend knows to parse the response as a fragment
  res.setHeader('Vary', FRAGMENT_HEADER);
  res.status(200).json(fragment);
}

/** Assembles the strictest CSP that still runs the reader's inline styles and scripts */
function contentSecurityPolicy(nonce: string, options: HtmlOptions): string {
  return [
    "default-src 'none'",
    "img-src 'self'",

    `style-src 'self' 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "form-action 'self'",
    `frame-src ${options.embedsFrames ? "'self'" : "'none'"}`,
    `frame-ancestors ${options.framedBySelf ? "'self'" : "'none'"}`,
    "base-uri 'none'",
    "connect-src 'self'",
  ].join('; ');
}

/** Applies the security headers every HTML response must carry, then caching */
function htmlSecurityHeaders(res: Response, nonce: string, options: HtmlOptions): void {
  res.setHeader('Content-Security-Policy', contentSecurityPolicy(nonce, options));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  res.setHeader('X-Frame-Options', options.framedBySelf ? 'SAMEORIGIN' : 'DENY');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  applyCaching(res, options);
}

/** Public caching: anonymous, 200, mints no cookie, reflects no caller input */
function applyCaching(res: Response, options: HtmlOptions): void {
  res.setHeader(
    'Vary',
    [...(options.varyAccept ? ['Accept'] : []), 'Cookie', 'Authorization'].join(', '),
  );

  const maxAge = env('SPEICHER_PUBLIC_MAX_AGE');
  const anonymous = res.req?.caller?.identity == null;
  const status = options.status ?? 200;

  const mintsCookie = res.getHeader('Set-Cookie') !== undefined;
  if (
    maxAge <= 0 ||
    options.noStore === true ||
    !anonymous ||
    status !== 200 ||
    mintsCookie ||
    reflectsCallerInput(res.req)
  ) {
    res.setHeader('Cache-Control', 'private, no-store');
    return;
  }
  res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
}

export interface HtmlOptions {
  status?: number;

  varyAccept?: boolean;

  embedsFrames?: boolean;

  framedBySelf?: boolean;
  /** noStore sends the page with `private, no-store`, so no cache keeps a copy of it. */
  noStore?: boolean;
}

/** Sends an HTML response with a fresh nonce, security headers, and the given status */
export function sendHtml(
  res: Response,
  build: (nonce: string) => string,
  options: HtmlOptions = {},
): void {
  const nonce = newNonce();
  htmlSecurityHeaders(res, nonce, options);
  res.status(options.status ?? 200).send(build(nonce));
}

/**
 * Escapes a string for safe interpolation into HTML
 * Order matters: & first so the later entities are not double-escaped
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
