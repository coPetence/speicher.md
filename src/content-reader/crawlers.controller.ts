/**
 * Search-engine crawler endpoints
 *
 * robots.txt and sitemap.xml for search engine crawlers
 * Only pages visible to anonymous callers are included in the sitemap
 * A tenant with no public repos gets a disallow-all robots.txt and no sitemap
 * The sitemap URL is the instance's declared base URL, not the request host
 *
 * Not fetched on crawl to avoid the authorization layer
 */
import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { callerOf } from '../auth/caller.middleware';
import { CrawlRepository } from '../authz/content/crawl.repository';
import { PUBLIC_PRINCIPAL } from '../common/principals';
import { Logger, rootLogger } from '../common/logger';
import { instanceBaseUrl } from '../common/env';
import { ConfigService } from '../config/config.service';
import { RoutingService } from './routing';

@Controller()
export class CrawlerController {
  private readonly log: Logger = rootLogger.child('crawlers');

  /** The sitemap protocol limits a single file to 50 000 URLs */
  private static readonly MAX_URLS = 50_000;

  constructor(
    private readonly crawl: CrawlRepository,
    private readonly routing: RoutingService,
    private readonly config: ConfigService,
  ) {}

  @Get('robots.txt')
  robots(@Res() res: Response): void {
    const body = this.config.publicRepos.length === 0 ? DISALLOW_ALL : this.allowWithSitemap();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Cached by shared caches for one hour
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(body);
  }

  @Get('sitemap.xml')
  async sitemap(@Req() req: Request, @Res() res: Response): Promise<void> {
    const base = instanceBaseUrl();

    if (base === null || this.config.publicRepos.length === 0) {
      res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send('Not found\n');
      return;
    }

    const caller = callerOf(req);
    const rows = await this.crawl.crawlablePages(
      // Only public pages, regardless of who the caller is
      [PUBLIC_PRINCIPAL],
      caller.tenantId,
      CrawlerController.MAX_URLS,
    );
    if (rows.length === CrawlerController.MAX_URLS) {
      this.log.warn('sitemap truncated at the protocol limit', {
        limit: CrawlerController.MAX_URLS,
      });
    }

    const urls = rows.map(
      (row) =>
        `  <url><loc>${xmlEscape(base + this.routing.publicPathFor(row, row.slug_path))}</loc></url>`,
    );
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `${urls.join('\n')}${urls.length > 0 ? '\n' : ''}` +
        `</urlset>\n`,
    );
  }

  /** Allow rules plus a Sitemap directive, or a comment explaining why there is none */
  private allowWithSitemap(): string {
    const base = instanceBaseUrl();
    return (
      DISALLOW_RESERVED +
      (base === null
        ? '\n# No Sitemap: SPEICHER_PUBLIC_URL is unset, so this instance does not know its\n' +
          '# own absolute URL and will not take one from the request.\n'
        : `\nSitemap: ${base}/sitemap.xml\n`)
    );
  }
}

/** Blocks all crawlers, used when no repo has been published as public */
const DISALLOW_ALL = ['User-agent: *', 'Disallow: /', ''].join('\n');

/** Blocks reserved paths while allowing public content pages */
const DISALLOW_RESERVED = [
  'User-agent: *',
  'Disallow: /-/',
  'Disallow: /auth/',
  'Disallow: /api/',
  'Disallow: /mcp',
  'Disallow: /*?',
  '',
].join('\n');

/** Escapes the five predefined XML entities for text content */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
