import type { ColourScheme } from '../../../config/palette';
import type { BrandNameAlign } from '../../../config/types';
import { renderTemplate } from '../../../content-reader/views';

/** The reader's signed-in identity, shown in the header avatar */
export interface AccountChrome {
  name: string;

  initials: string;
  email: string | null;
  isAdmin: boolean;

  /**
   * Inline SVG for each item of the menu, keyed by item rather than by icon name
   *
   * Inline rather than a <use> into the per-page sprite, for the reason the search
   * mark is: the sprite is assembled from what the body renders and this control is
   * drawn around bodies that reference no icon at all
   */
  icons: AccountMenuIcons;
}

/** The marks beside the three items of the account menu */
export interface AccountMenuIcons {
  dashboard: string;
  connections: string;
  signOut: string;
}

/** Everything the layout template needs beyond the body markup */
export interface PageChrome {
  title: string;
  description?: string | null;
  nonce: string;

  crawlable?: boolean;

  countable?: boolean;
  nav?: string;

  /**
   * The repository whose tree `nav` is, as its public base path — `Fragment.tree`'s
   * other half. Sets `data-spr-tree` on the shell
   */
  tree?: string;

  /**
   * The body is a reader article: a `.spr-article` wrapper and, maybe, an aside
   *
   * Sets `data-article` on the shell, which is what reserves the related column's
   * track at wide widths. Opt-in, so a page that forgot gets the plain layout
   * rather than a grid with its paragraphs in the cells; never set under `/-/`
   */
  article?: boolean;

  /**
   * A reading page — a document or a folder — whose search box and account control
   * sit at the top of the content card rather than in the header
   *
   * Sets `data-docked` on the shell. Only the two views that answer a fragment set
   * it, so a fragment swap never crosses from one shell to the other
   */
  docked?: boolean;
  query?: string;

  /** If the progressBar from the setup should be shown */
  progressBar?: string;

  sprite?: string;

  island?: string | null;

  stylesheet?: string | null;

  extraStylesheet?: string | null;

  themeTokens?: string | null;

  scheme?: ColourScheme | null;

  /** A wallpaper is set: the header and tree get a frosted backing over it */
  wallpaper?: boolean;

  tui?: boolean;

  account?: AccountChrome | null;

  signInHref?: string | null;

  search?: boolean;

  brand: string;

  brandLogo?: string | null;

  brandLogoDark?: string | null;

  brandMark?: string | null;

  faviconUrl?: string | null;

  faviconType?: string | null;

  searchIcon?: string | null;

  brandNameShown?: boolean;

  brandNameAlign?: BrandNameAlign;

  attribution?: boolean;

  overlay?: string | null;
}

/** Wraps body markup in the layout template */
export function renderPage(body: string, chrome: PageChrome): string {
  return renderTemplate('global-ui/global-views/page-layout', { ...chrome, body });
}
