import type { Request, Response } from 'express';

import { SearchHit } from '../../../authz/content/types';
import { ConfigService } from '../../../config/config.service';
import { pageChrome } from '../../chrome';
import { emptyStateArt } from '../../empty-state';
import { withRepoBase } from '../../../ingest/paths';
import { excerptOf, searchTerms } from './excerpt';
import { iconOf, renderIconRef, renderSprite } from '../../icons';
import { RoutingService } from '../../routing';
import { renderTemplate, sendHtml } from '../../views';
import { renderPage } from '../../../global-ui/global-views/page-layout/page-layout';

/** Sends the reader's search results for a query */
export function sendSearch(
  req: Request,
  res: Response,
  config: ConfigService,
  routing: RoutingService,
  query: string,
  results: SearchHit[],
): void {
  const terms = searchTerms(query);
  const body = renderTemplate('content-reader/views/search', {
    query,
    count: results.length,
    art: emptyStateArt('unmatched'),
    results: results.map((hit) => {
      const repo = { namespace: hit.repo_namespace, slug: hit.repo_slug, forge_key: hit.forge_key };
      // The block the hit landed in, as the page draws it, and the plain snippet
      // where no block spells the term as typed — a stemmed or fuzzy match. The
      // sentinel is swapped first, as the page route swaps it. The link carries
      // the excerpt's text directive, so opening the result lands on the words
      // the card shows, still marked — see `Excerpt.fragment` for why it is a
      // fragment and not a query parameter.
      const excerpt = excerptOf(withRepoBase(hit.html, routing.publicBaseFor(repo)), terms);
      const path = routing.publicPathFor(repo, hit.slug_path);
      return {
        title: hit.title,
        icon: renderIconRef(iconOf(markOf(hit))),
        href: excerpt?.fragment ? `${path}#${excerpt.fragment}` : path,
        repo: `${hit.repo_namespace}/${hit.repo_slug}`,
        excerpt: excerpt?.html ?? `<p>${hit.snippet}</p>`,
      };
    }),
  });
  sendHtml(res, (nonce) =>
    renderPage(body, {
      title: `Search — ${query}`,
      nonce,
      query,
      sprite: renderSprite(results.map((hit) => iconOf(markOf(hit)))),
      article: true,
      ...pageChrome(req, config),
    }),
  );
}

/** A hit's mark is its page's, and an index page carries its folder's — as the tree draws it */
function markOf(hit: SearchHit): { icon: string | null; kind: 'page' | 'folder' } {
  return { icon: hit.icon, kind: hit.is_index ? 'folder' : 'page' };
}
