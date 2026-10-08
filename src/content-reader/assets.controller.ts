/**
 * Client build artifacts and the brand images: URL helpers and the routes that serve them
 *
 * Islands and stylesheets build into `dist/client` with content-hashed filenames,
 * mapped by manifest.json from artifact name to file
 * A missing client build is not fatal: every URL helper returns null, and pages
 * render without island scripts or stylesheets
 *
 * Every file served here carries the hash of its bytes in its name, so a year of
 * `immutable` caching is safe on both routes
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';

import { isProduction } from '../common/env';
import { Logger, rootLogger } from '../common/logger';
import { ConfigService } from '../config/config.service';
import type { ColourScheme } from '../config/palette';
import { DEFAULT_BRAND_ICON, renderIconDocument } from './icons';

/** First existing client build: the compiled server's sibling, else repo-root dist */
export function clientDir(): string | undefined {
  return [join(__dirname, '..', 'client'), join(process.cwd(), 'dist', 'client')].find((dir) =>
    existsSync(join(dir, 'manifest.json')),
  );
}

/** Manifest cache: undefined until first read, null when there is no build */
let manifest: Record<string, string> | null | undefined;

/**
 * The client build's manifest, or null when there is no build
 *
 * A missing build is logged, and every URL helper degrades to null
 */
export function clientManifest(): Record<string, string> | null {
  // Re-read in development so a rebuild is picked up without a restart;
  // cached after the first read in production
  if (manifest !== undefined && isProduction()) return manifest;
  try {
    const dir = clientDir();
    if (!dir) throw new Error('no client build');
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<
      string,
      string
    >;
  } catch {
    manifest = null;
    rootLogger.child('static').warn('no client bundle found; pages will ship no island script');
  }
  return manifest;
}

/** Public URL of a manifest artifact (island or sheet), or null when absent */
export function islandUrl(name: string): string | null {
  const file = clientManifest()?.[name];
  return file ? `/-/static/${file}` : null;
}

/** The always-built template, and the fallback for an unbuilt one */
export const DEFAULT_TEMPLATE = 'default';

/** The admin sheet, loaded beside the template sheet on admin surfaces only */
export function dashboardStylesheetUrl(): string | null {
  return islandUrl('sheet-dashboard');
}

/** The setup sheet, loaded beside the template sheet on setup surfaces only */
export function setupStylesheetUrl(): string | null {
  return islandUrl('sheet-setup');
}

/** Manifest prefixes of the fixed-scheme variant the build emits per template */
const SCHEME_PREFIXES = ['theme-light-', 'theme-dark-'];

/** Bare names of built templates, scheme variants excluded, sorted */
export function templateNames(): string[] {
  return Object.keys(clientManifest() ?? {})
    .filter((k) => k.startsWith('theme-') && !SCHEME_PREFIXES.some((p) => k.startsWith(p)))
    .map((k) => k.slice('theme-'.length))
    .sort();
}

/** Template names already logged, so the fallback error fires once per name */
const reportedMissing = new Set<string>();

/**
 * URL of a template's sheet, fixed to a chosen scheme when one is given
 *
 * An unbuilt template falls back to the default, logging the miss once per name
 */
export function stylesheetUrl(
  template: string = DEFAULT_TEMPLATE,
  scheme: ColourScheme | null = null,
): string | null {
  const url = sheetFor(template, scheme);
  if (url) return url;

  if (template !== DEFAULT_TEMPLATE && !reportedMissing.has(template)) {
    reportedMissing.add(template);
    rootLogger.child('theme').error('unknown theme template; falling back to the default', {
      template,
      available: templateNames(),
    });
  }
  return sheetFor(DEFAULT_TEMPLATE, scheme);
}

/** Prefers the fixed-scheme variant sheet, then the plain template sheet */
function sheetFor(template: string, scheme: ColourScheme | null): string | null {
  const variant = scheme ? islandUrl(`theme-${scheme}-${template}`) : null;
  return variant ?? islandUrl(`theme-${template}`);
}

/** Serves client build files at `/-/static` */
@Controller('-/static')
export class StaticController {
  private readonly log: Logger = rootLogger.child('static');

  @Get(':file')
  serve(@Param('file') file: string, @Res() res: Response): void {
    // Only files the build produced, plus their `.map` siblings; the whitelist,
    // not a path check, is what makes `join` with caller input safe
    const known = new Set(Object.values(clientManifest() ?? {}));
    const withMaps = new Set([...known, ...[...known].map((f) => `${f}.map`)]);
    if (!withMaps.has(file)) {
      res.status(404).end();
      return;
    }

    const path = join(clientDir() as string, file);
    if (!existsSync(path)) {
      this.log.warn('manifest names a file that is not on disk', { file });
      res.status(404).end();
      return;
    }

    const type = file.endsWith('.map')
      ? 'application/json'
      : file.endsWith('.css')
        ? 'text/css'
        : 'text/javascript';
    res.setHeader('Content-Type', type);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.status(200).send(readFileSync(path));
  }
}

function sendBrandImage(res: Response, mediaType: string, bytes: Buffer, cache: string): void {
  res.setHeader('Content-Type', mediaType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );

  res.setHeader('Cache-Control', cache);
  res.status(200).send(bytes);
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

@Controller('-/brand')
export class BrandController {
  constructor(private readonly config: ConfigService) {}

  @Get(':file')
  serve(@Param('file') file: string, @Res() res: Response): void {
    const image = this.config.brandImages.find((each) => each.file === file);
    if (!image) {
      res.status(404).end();
      return;
    }

    sendBrandImage(res, image.mediaType, image.bytes, IMMUTABLE);
  }
}

let defaultIcon: Buffer | undefined;

@Controller()
export class FaviconController {
  constructor(private readonly config: ConfigService) {}

  @Get('favicon.ico')
  serve(@Res() res: Response): void {
    const icon = this.config.brandIcon;
    if (icon) {
      sendBrandImage(res, icon.mediaType, icon.bytes, 'public, max-age=3600');
      return;
    }

    defaultIcon ??= Buffer.from(renderIconDocument(DEFAULT_BRAND_ICON), 'utf8');
    sendBrandImage(res, 'image/svg+xml', defaultIcon, 'public, max-age=3600');
  }
}
