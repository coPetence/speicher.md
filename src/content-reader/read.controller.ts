/**
 * Page, folder, asset and redirect serving
 *
 * Authored content is loaded through the repositories in `authz/content/`, which
 * enforce the caller's permissions.  Routing translates URL path segments into a
 * resolved repo + slug pair
 *
 * A visitor may request a full page (default) or a JSON fragment via
 * X-Spr-Fragment.  Fragments are used by the frontend navigator to swap
 * content without reloading chrome
 */
import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';

import { AnalyticsService } from '../dashboard/analytics/analytics.service';
import { BlobCache, BlobStore } from '../assets/blob-store';
import { callerOf } from '../auth/caller.middleware';
import { SessionService } from '../auth/session.service';
import { ResolvedCaller } from '../authz/caller';
import { GraphRepository } from '../authz/content/graph.repository';
import { PageRepository } from '../authz/content/pages.repository';
import { AssetRow, ChildRow, RelatedRow, TermRow } from '../authz/content/types';
import { env } from '../common/env';
import { reasonOf } from '../common/errors';
import { parseDurationWithFallback } from '../common/time';
import { Logger, rootLogger } from '../common/logger';
import { splitPath } from '../common/slug';
import { ConfigService } from '../config/config.service';
import { getSequelize } from '../db/sequelize';
import { BLOB_STORE } from '../ingest/ingest.module';
import { SearchService } from './search/search.service';
import { CLAIM_COOKIE, claimCookieOptions } from '../dashboard/setup/claim-cookie';
import { SetupService } from '../dashboard/setup/setup.service';
import { landingCover } from './covers';
import { ResolvedRoute, RoutingService, repoRefOf } from './routing';
import { sendListing } from './views/folder-listing/folder-listing';
import { redirectToSignIn, sendNotFound } from '../global-ui/global-views/not-found/not-found';
import { sendPage } from './views/content-page/content-page';
import { sendRoot } from './views/repo-listing/repo-listing';
import { sendSearch } from './views/search/search';
import { ClaimView, sendSetupClaim } from '../dashboard/ui/views/setup/setup-claim/setup-claim';
import { sendTag } from './views/tag/tag';

@Controller()
export class ReadController {
  // Max related rows examined for link-preview data
  private static readonly LINK_PREVIEW_CAP = 200;

  private readonly cache = new BlobCache();
  private readonly log: Logger = rootLogger.child('read');

  constructor(
    private readonly pages: PageRepository,
    private readonly graph: GraphRepository,
    private readonly routing: RoutingService,
    private readonly search: SearchService,
    private readonly config: ConfigService,
    private readonly setup: SetupService,
    private readonly sessions: SessionService,
    private readonly analytics: AnalyticsService,

    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
  ) {}

  @Get('/')
  async root(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);

    if (await this.serveSetup(caller, req, res)) return;

    const tag = typeof req.query.tag === 'string' ? req.query.tag.trim() : '';
    if (tag && this.config.graph.terms) {
      const results = await this.graph.listByTerm(caller.principals, caller.tenantId, tag);

      if (results.length === 0) {
        this.notFound(req, res);
        return;
      }
      sendTag(req, res, this.config, this.routing, tag, results);
      return;
    }

    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (query) {
      const results = await this.search.search(caller, query, { limit: 25 });

      if (results.length === 0) this.analytics.recordSearchMiss(caller, query);
      sendSearch(req, res, this.config, this.routing, query, results);
      return;
    }

    const repos = await this.pages.listVisibleRepos(caller.principals, caller.tenantId);
    // If there is no public repo sign in is required
    if (repos.length === 0 && redirectToSignIn(req, res, this.config)) return;
    sendRoot(req, res, this.config, this.routing, caller.identity !== null, caller.isAdmin, repos);
  }

  // Serves the claim-code page when the instance has no administrator yet
  private async serveSetup(caller: ResolvedCaller, req: Request, res: Response): Promise<boolean> {
    if (
      !(await this.setup.showsClaimPage(caller.tenantId, {
        source: this.config.configSource,
        hasAdministrator: this.config.hasAdministrator,
      }))
    )
      return false;

    const cookie = req.cookies?.[CLAIM_COOKIE];
    const token = typeof cookie === 'string' && cookie.length > 0 ? cookie : null;

    if (token) {
      const redeemed = await this.setup.redeem(caller.tenantId, token);
      if (redeemed) {
        await this.sessions.createSetupSession(caller.tenantId, redeemed.code, res);

        // Token consumed; redirect to the setup UI proper
        res.clearCookie(CLAIM_COOKIE, { ...claimCookieOptions(req), maxAge: undefined });
        this.log.info('setup claim redeemed', { code: redeemed.code });

        res.redirect(303, '/-/setup');
        return true;
      }
    }

    // if we have a token, we can try to get the claim corresponding to that token from the database. If we don't have a token
    let claim: ClaimView | null = token
      ? await this.setup.getLiveClaim(caller.tenantId, token)
      : null;
    if (!claim) {
      const origin = originOf(req);
      const mintedClaim = await this.setup.mintClaim(caller.tenantId, origin);
      res.cookie(CLAIM_COOKIE, mintedClaim.token, claimCookieOptions(req));
      claim = { code: mintedClaim.code, origin, created_at: new Date() };
    }

    sendSetupClaim(req, res, this.config, claim);
    return true;
  }

  @Get('{*path}')
  async anything(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    const segments = splitPath(decodeURIComponent(req.path));
    if (segments === null || segments.length === 0) {
      this.notFound(req, res);
      return;
    }

    const route = await this.routing.resolve(caller.tenantId, segments);
    if (!route) {
      this.notFound(req, res);
      return;
    }

    if (route.redirectTo) {
      const visible = await this.pages.resolveRedirectTarget(
        caller.principals,
        caller.tenantId,
        route.repoId,
        route.slugPath,
      );
      if (!visible) {
        this.notFound(req, res);
        return;
      }
      res.redirect(301, route.redirectTo);
      return;
    }

    if (await this.tryPage(caller, route, req, res)) return;
    if (await this.tryAsset(caller, route, req, res)) return;
    if (await this.tryFolder(caller, route, req, res)) return;
    if (await this.tryRedirect(caller, route, res)) return;

    this.notFound(req, res);
  }

  // Attempts to render a document page for the resolved route
  private async tryPage(
    caller: ResolvedCaller,
    route: ResolvedRoute,
    req: Request,
    res: Response,
  ): Promise<boolean> {
    // The index page of a repo is rendered via the index handler not a named doc
    if (route.slugPath.split('/').pop() === 'index') return false;

    const page = await this.pages.getPage(
      caller.principals,
      caller.tenantId,
      route.repoId,
      route.slugPath,
    );
    if (!page) return false;

    const base = this.routing.publicBaseFor(repoRefOf(route));

    const countedHere = !this.analytics.beaconCounts(page.is_public);
    this.analytics.recordPageView(caller, route.repoId, page.slug_path, 'web', page.is_public);

    const graph = this.config.graph;
    const [nav, children, related, terms, coverPath] = await Promise.all([
      this.pages.navNodes(caller.principals, caller.tenantId, route.repoId),

      page.is_index
        ? this.pages.listChildren(caller.principals, caller.tenantId, route.repoId, page.slug_path)
        : Promise.resolve([] as ChildRow[]),
      graph.related || graph.previews
        ? this.graph.relatedTo(caller.principals, caller.tenantId, route.repoId, page.slug_path, {
            outbound: graph.previews ? ReadController.LINK_PREVIEW_CAP : graph.related_limit,
            inbound: graph.related_limit,
          })
        : Promise.resolve({ outbound: [] as RelatedRow[], inbound: [] as RelatedRow[] }),
      graph.terms
        ? this.graph.termsFor(caller.principals, caller.tenantId, route.repoId, page.slug_path)
        : Promise.resolve([] as TermRow[]),
      // A cover is drawn on the repository's landing page and nowhere else, so
      // nowhere else asks. `''` is that page: the root `index.md`'s slug.
      route.slugPath === ''
        ? this.pages.repoCover(caller.principals, caller.tenantId, route.repoId)
        : Promise.resolve(null),
    ]);

    sendPage(req, res, this.config, this.routing, {
      page,
      base,
      nav,
      children,
      related,
      terms,
      crumbs: await this.breadcrumbs(caller, route, page.slug_path, base),
      cover: landingCover(repoRefOf(route), base, coverPath),
      countedHere,
    });
    return true;
  }

  // Attempts to render a folder listing for the resolved route
  // Not called on empty folders; they produce 404
  private async tryFolder(
    caller: ResolvedCaller,
    route: ResolvedRoute,
    req: Request,
    res: Response,
  ): Promise<boolean> {
    const folder = await this.pages.getFolder(
      caller.principals,
      caller.tenantId,
      route.repoId,
      route.slugPath,
    );
    if (!folder) return false;

    const children = await this.pages.listChildren(
      caller.principals,
      caller.tenantId,
      route.repoId,
      route.slugPath,
    );

    if (children.length === 0) return false;

    const base = this.routing.publicBaseFor(repoRefOf(route));

    const [nav, coverPath] = await Promise.all([
      this.pages.navNodes(caller.principals, caller.tenantId, route.repoId),
      // The generated listing *is* the landing page when the root has no
      // `index.md`, and is an ordinary folder at every other depth.
      route.slugPath === ''
        ? this.pages.repoCover(caller.principals, caller.tenantId, route.repoId)
        : Promise.resolve(null),
    ]);
    sendListing(req, res, this.config, {
      folder,
      base,
      nav,
      children,
      crumbs: await this.breadcrumbs(caller, route, route.slugPath, base),
      cover: landingCover(repoRefOf(route), base, coverPath),
    });
    return true;
  }

  private async redirectToStore(
    caller: ResolvedCaller,
    asset: AssetRow,
    route: ResolvedRoute,
    res: Response,
  ): Promise<boolean> {
    const { presign_over_bytes: over, presign_ttl: ttl } = this.config.assets;
    if (!over || over <= 0 || asset.size_bytes <= over) return false;
    if (asset.mime.startsWith('image/')) return false;

    const filename = asset.slug_path.split('/').pop() ?? 'asset';
    let url: string | null = null;
    try {
      url = await this.blobs.presign(route.repoId, asset.content_hash, {
        ttlSeconds: Math.round(parseDurationWithFallback(ttl, '60s') / 1000),
        filename,
        mime: asset.mime,
      });
    } catch (err) {
      this.log.warn('could not presign an asset, serving it instead', {
        repo_id: route.repoId,
        slug_path: asset.slug_path,
        store: this.blobs.kind,
        reason: reasonOf(err),
      });
      return false;
    }
    if (url === null) return false;

    this.log.debug('handed an asset to the store', {
      repo_id: route.repoId,
      slug_path: asset.slug_path,
      store: this.blobs.kind,
      anonymous: caller.identity === null,
    });

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Cookie, Authorization');
    res.redirect(302, url);
    return true;
  }

  // Serves a binary asset from the blob store with conditional GET via ETag
  // Public assets get longer cache lifetime
  private async tryAsset(
    caller: ResolvedCaller,
    route: ResolvedRoute,
    req: Request,
    res: Response,
  ): Promise<boolean> {
    const asset = await this.pages.getAsset(
      caller.principals,
      caller.tenantId,
      route.repoId,
      route.slugPath,
    );
    if (!asset) return false;

    const ifNoneMatch = req.headers['if-none-match'];
    const revalidated = typeof ifNoneMatch === 'string' && ifNoneMatch.includes(asset.content_hash);

    if (!revalidated && (await this.redirectToStore(caller, asset, route, res))) return true;

    let bytes: Buffer | null = null;
    if (!revalidated) {
      const cacheKey = `${route.repoId}/${asset.content_hash}`;
      bytes = this.cache.get(cacheKey) ?? null;
      if (bytes === null) {
        try {
          bytes = await this.blobs.get(route.repoId, asset.content_hash);
          this.cache.set(cacheKey, bytes);
        } catch (err) {
          this.log.warn('asset could not be read from the store', {
            repo_id: route.repoId,
            slug_path: asset.slug_path,
            store: this.blobs.kind,
            reason: reasonOf(err),
          });
          return false;
        }
      }
    }

    res.setHeader('ETag', `"${asset.content_hash}"`);
    res.setHeader('Vary', 'Cookie, Authorization');
    const publicMaxAge = env('SPEICHER_PUBLIC_MAX_AGE');
    res.setHeader(
      'Cache-Control',
      caller.identity === null && publicMaxAge > 0
        ? `public, max-age=${publicMaxAge}, must-revalidate`
        : 'private, must-revalidate',
    );

    // Prevent MIME sniffing for security
    res.setHeader('Content-Type', asset.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${asset.slug_path.split('/').pop()?.replace(/["\\]/g, '') ?? 'asset'}"`,
    );

    if (revalidated) {
      res.status(304).end();
      return true;
    }
    res.status(200).end(bytes as Buffer);
    return true;
  }

  // Looks up a database redirect row and issues a 301 if the target is visible
  private async tryRedirect(
    caller: ResolvedCaller,
    route: ResolvedRoute,
    res: Response,
  ): Promise<boolean> {
    const rows = await getSequelize().query<{ to_path: string }>(
      `SELECT to_path FROM redirects
        WHERE tenant_id = :tenantId AND repo_id = :repoId
          AND from_path = :fromPath AND retired_at IS NULL
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantId: caller.tenantId,
          repoId: route.repoId,
          fromPath: route.slugPath,
        },
      },
    );
    const target = rows[0]?.to_path;
    if (target === undefined) return false;

    const visible = await this.pages.resolveRedirectTarget(
      caller.principals,
      caller.tenantId,
      route.repoId,
      target,
    );
    if (!visible) return false;

    res.redirect(301, this.routing.publicPathFor(repoRefOf(route), target));
    return true;
  }

  // Walks parent folders to build a breadcrumb trail.  Skips folders without
  // a content row; the repo root is always included
  private async breadcrumbs(
    caller: ResolvedCaller,
    route: ResolvedRoute,
    slugPath: string,
    base: string,
  ): Promise<{ title: string; href: string }[]> {
    const parts = slugPath.split('/').filter(Boolean);
    const crumbs: { title: string; href: string }[] = [{ title: route.repoSlug, href: `${base}/` }];
    let accumulated = '';
    for (const part of parts.slice(0, -1)) {
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      const folder = await this.pages.getFolder(
        caller.principals,
        caller.tenantId,
        route.repoId,
        accumulated,
      );
      if (folder) crumbs.push({ title: folder.title, href: `${base}/${accumulated}` });
    }
    return crumbs;
  }

  private notFound(req: Request, res: Response): void {
    sendNotFound(req, res, this.config);
  }
}

function originOf(req: Request): string {
  return req.ip ?? 'unknown';
}
