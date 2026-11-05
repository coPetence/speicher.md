import type { Request, Response } from 'express';

import { RelatedRow } from '../../../authz/content/types';
import { ConfigService } from '../../../config/config.service';
import { pageChrome } from '../../chrome';
import { iconOf, renderIconRef, renderSprite } from '../../icons';
import { RoutingService } from '../../routing';
import { renderTemplate, sendHtml } from '../../views';
import { renderPage } from '../../../global-ui/global-views/page-layout/page-layout';

/** Sends the list of pages carrying a tag */
export function sendTag(
  req: Request,
  res: Response,
  config: ConfigService,
  routing: RoutingService,
  tag: string,
  results: RelatedRow[],
): void {
  const body = renderTemplate('content-reader/views/tag', {
    tag,
    results: results.map((row) => ({
      title: row.title,
      description: row.description,
      icon: renderIconRef(iconOf(row)),
      repo: `${row.repo_namespace}/${row.repo_slug}`,
      href: routing.publicPathFor(
        { namespace: row.repo_namespace, slug: row.repo_slug, forge_key: row.forge_key },
        row.slug_path,
      ),
    })),
  });
  sendHtml(res, (nonce) =>
    renderPage(body, {
      title: `Tagged “${tag}” - speicher.md`,
      nonce,
      sprite: renderSprite(results.map(iconOf)),
      article: true,
      ...pageChrome(req, config),
    }),
  );
}
