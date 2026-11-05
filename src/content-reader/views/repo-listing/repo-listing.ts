import type { Request, Response } from 'express';

import type { PageRepository } from '../../../authz/content/pages.repository';
import { ConfigService } from '../../../config/config.service';
import { islandUrl } from '../../assets.controller';
import { pageChrome } from '../../chrome';
import { cardCover } from '../../covers';
import { emptyStateArt } from '../../empty-state';
import { RoutingService } from '../../routing';
import { renderTemplate, sendHtml } from '../../views';
import { renderPage } from '../../../global-ui/global-views/page-layout/page-layout';

type VisibleRepo = Awaited<ReturnType<PageRepository['listVisibleRepos']>>[number];

/** Sends the front page: a card for every repository the caller can read */
export function sendRoot(
  req: Request,
  res: Response,
  config: ConfigService,
  routing: RoutingService,
  authenticated: boolean,
  isAdmin: boolean,
  repos: VisibleRepo[],
): void {
  const body = renderTemplate('content-reader/views/repo-listing', {
    authenticated,
    is_admin: isAdmin,
    has_content_source: config.hasContentSource,
    empty_art: repos.length === 0 ? emptyStateArt('sources') : '',
    repos: repos.map((repo, index) => {
      const base = routing.publicBaseFor({
        namespace: repo.namespace,
        slug: repo.slug,
        forge_key: repo.forge_key,
      });
      return {
        title: repo.title,
        name: `${repo.namespace}/${repo.slug}`,
        href: base,

        // Why the tile travels with every card, and why the landing page's cover
        // comes out of the same function: `content-reader/covers.ts`.
        cover: cardCover(repo, base, repo.cover_path, `spr-cover-${index}`),
      };
    }),
  });
  sendHtml(res, (nonce) =>
    renderPage(body, {
      title: 'speicher.md',
      nonce,
      // Not the tree island: its router would turn a card into a fragment swap
      // onto a page whose tree this one never had. The root's own island does
      // one thing — swap a cover that failed to load for its tile.
      island: islandUrl('covers'),
      crawlable: config.publicRepos.length > 0,
      article: true,
      ...pageChrome(req, config),
    }),
  );
}
