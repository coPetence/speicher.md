import type { Request, Response } from 'express';

import { ChildRow, PageRow, RelatedRow, TermRow } from '../../../authz/content/types';
import { ConfigService } from '../../../config/config.service';
import { ReaderCover } from '../../covers';
import { headingSlug } from '../../../ingest/markdown';
import { withRepoBase } from '../../../ingest/paths';
import { islandUrl } from '../../assets.controller';
import { pageChrome } from '../../chrome';
import { iconOf, renderIconRef, renderSprite, symbolsFor } from '../../icons';
import { buildNavTree } from '../../nav';
import { LinkPreview, annotateLinkPreviews } from '../../previews';
import { RoutingService } from '../../routing';
import { isFragmentRequest, renderTemplate, sendFragment, sendHtml } from '../../views';
import { renderPage } from '../../../global-ui/global-views/page-layout/page-layout';
import { childLink } from '../folder-listing/folder-listing';

/** A document page and what the page around it needs */
export interface PageView {
  page: PageRow;
  /** The repository's public URL prefix */
  base: string;
  nav: ChildRow[];
  /** An index page's children; empty on any other page */
  children: ChildRow[];
  related: { outbound: RelatedRow[]; inbound: RelatedRow[] };
  terms: TermRow[];
  /**
   * The repository's picture, on the repository's landing page and on no other —
   * `content-reader/covers.ts`. The route decides, because whether this caller may
   * fetch the bytes is a query (`repoCover`) and not a column on the page's row.
   */
  cover: ReaderCover | null;
  crumbs: { title: string; href: string }[];
  /** False when the browser beacon counts this read, not the server */
  countedHere: boolean;
}

/** Sends a document page, as a full page or as the fragment the tree island asked for */
export function sendPage(
  req: Request,
  res: Response,
  config: ConfigService,
  routing: RoutingService,
  view: PageView,
): void {
  const { page, base, nav, children, related, terms, crumbs, cover, countedHere } = view;
  const graph = config.graph;

  // Rewrite relative image/src links to absolute repo base
  const html = withRepoBase(page.html, base);
  // An index page is the folder, so it is drawn with the mark the tree draws the
  // folder with — the two must not name one thing two ways. `headingSlug` is the
  // renderer's own, not a second spelling of it: the id it produces has to be the
  // one an anchor written against the heading ingest removed was aiming at.
  const mark = iconOf({ icon: page.icon, kind: page.is_index ? 'folder' : 'page' });
  const body = renderPageBody({
    html: graph.previews
      ? annotateLinkPreviews(html, previewsFor(routing, related.outbound))
      : html,
    title: page.title,
    headingId: headingSlug(page.title),
    icon: renderIconRef(mark),
    crumbs,
    cover,
    children: children.map((c) => childLink(c, base)),
    aside: buildAside(
      routing,
      { outbound: related.outbound.slice(0, graph.related_limit), inbound: related.inbound },
      terms,
      graph.related,
    ),
  });

  const contentIcons = [
    mark,
    ...children.map(iconOf),
    ...related.outbound.map(iconOf),
    ...related.inbound.map(iconOf),
  ];
  if (isFragmentRequest(req)) {
    // Send only the content pane; the frontend swaps it into the existing shell
    sendFragment(res, {
      title: page.title,
      html: body,
      symbols: symbolsFor(contentIcons),
      countable: !countedHere,
      tree: base,
    });
    return;
  }

  const tree = buildNavTree(nav, base, page.slug_path);
  sendHtml(res, (nonce) =>
    renderPage(body, {
      title: page.title,
      description: page.description,
      nonce,

      crawlable: page.is_public && page.indexable,

      countable: !countedHere,
      nav: tree.html,
      tree: base,

      sprite: renderSprite([...tree.icons, ...contentIcons]),
      island: islandUrl('tree'),
      article: true,
      docked: true,
      ...pageChrome(req, config),
      query: typeof req.query.q === 'string' ? req.query.q : '',
    }),
  );
}

/** The article markup alone, which the template gallery renders a demo page through too */
export function renderPageBody(data: Record<string, unknown>): string {
  return renderTemplate('content-reader/views/content-page', data);
}

// Builds the sidebar groups (See also, Referenced by) and tag list shown on
// a page.  Returns null when nothing should be rendered
function buildAside(
  routing: RoutingService,
  related: { outbound: RelatedRow[]; inbound: RelatedRow[] },
  terms: TermRow[],
  showRelated: boolean,
) {
  const link = (row: RelatedRow) => ({
    title: row.title,
    icon: renderIconRef(iconOf(row)),
    href:
      routing.publicPathFor(
        { namespace: row.repo_namespace, slug: row.repo_slug, forge_key: row.forge_key },
        row.slug_path,
      ) + (row.fragment ? `#${encodeURIComponent(row.fragment)}` : ''),
  });

  const groups = (
    showRelated
      ? [
          { heading: 'See also', items: related.outbound.map(link) },
          { heading: 'Referenced by', items: related.inbound.map(link) },
        ]
      : []
  ).filter((group) => group.items.length > 0);

  const tags = terms.map((t) => ({
    label: t.label,
    href: `/?tag=${encodeURIComponent(t.term)}`,
  }));

  if (groups.length === 0 && tags.length === 0) return null;
  return { groups, tags };
}

function previewsFor(routing: RoutingService, outbound: RelatedRow[]): LinkPreview[] {
  return outbound.map((row) => ({
    href: routing.publicPathFor(
      { namespace: row.repo_namespace, slug: row.repo_slug, forge_key: row.forge_key },
      row.slug_path,
    ),
    title: row.title,
    description: row.description,
  }));
}
