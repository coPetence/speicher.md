import type { Request, Response } from 'express';

import type { PageRepository } from '../../../authz/content/pages.repository';
import { ChildRow } from '../../../authz/content/types';
import { ConfigService } from '../../../config/config.service';
import { ReaderCover } from '../../covers';
import { islandUrl } from '../../assets.controller';
import { pageChrome } from '../../chrome';
import { iconOf, renderIconRef, renderSprite, symbolsFor } from '../../icons';
import { buildNavTree } from '../../nav';
import { isFragmentRequest, renderTemplate, sendFragment, sendHtml } from '../../views';
import { renderPage } from '../../../global-ui/global-views/page-layout/page-layout';

type Folder = NonNullable<Awaited<ReturnType<PageRepository['getFolder']>>>;

/** A folder listing and what the page around it needs */
export interface ListingView {
  folder: Folder;
  /** The repository's public URL prefix */
  base: string;
  nav: ChildRow[];
  children: ChildRow[];
  crumbs: { title: string; href: string }[];
  /** As on a document page: the repository's own landing page draws one, nothing else does. */
  cover: ReaderCover | null;
}

/** Sends a folder listing, as a full page or as the fragment the tree island asked for */
export function sendListing(
  req: Request,
  res: Response,
  config: ConfigService,
  view: ListingView,
): void {
  const { folder, base, nav, children, crumbs, cover } = view;
  const body = renderTemplate('content-reader/views/folder-listing', {
    heading: folder.title,
    icon: renderIconRef(iconOf({ kind: 'folder', icon: folder.icon })),
    crumbs,
    cover,
    children: children.map((c) => childLink(c, base)),
  });

  const contentIcons = [iconOf({ kind: 'folder', icon: folder.icon }), ...children.map(iconOf)];
  if (isFragmentRequest(req)) {
    sendFragment(res, {
      title: folder.title,
      html: body,
      symbols: symbolsFor(contentIcons),
      tree: base,
    });
    return;
  }

  const tree = buildNavTree(nav, base, folder.slug_path);
  sendHtml(res, (nonce) =>
    renderPage(body, {
      title: folder.title,
      nonce,

      nav: tree.html,
      tree: base,
      sprite: renderSprite([...contentIcons, ...tree.icons]),
      island: islandUrl('tree'),
      article: true,
      docked: true,
      ...pageChrome(req, config),
      query: typeof req.query.q === 'string' ? req.query.q : '',
    }),
  );
}

/** A child page or folder as a listing entry links to it */
export function childLink(child: ChildRow, base: string) {
  return {
    kind: child.kind,
    title: child.title,
    description: child.description,
    icon: renderIconRef(iconOf(child)),
    href: `${base}/${child.slug_path}`,
  };
}
