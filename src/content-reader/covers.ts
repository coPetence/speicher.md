/**
 * Where a repository's cover is drawn, and what it is drawn as.
 *
 * Two surfaces draw one: the overview card, and the repository's own landing page.
 * Nowhere else — a cover inherits down the config cascade, so following it would
 * put the same picture at the top of every page in the repository, which is how it
 * read before this file existed.
 *
 * Both go through here because the card is a *claim* about the landing page: a
 * reader recognises a repository by its picture and then arrives at it. Two call
 * sites hashing their own tile key, or cropping to their own box, is how the claim
 * comes to be false.
 */
import { renderCoverPattern } from './cover-patterns';

/** A repository as both surfaces name one. */
export interface CoverRepo {
  namespace: string;
  slug: string;
}

/**
 * The key the tile is hashed from. One repository resolves to one pattern, on the
 * card and on the page, so the fallback is not a different picture in each place.
 */
export function coverKey(repo: CoverRepo): string {
  return `${repo.namespace}/${repo.slug}`;
}

export interface ReaderCover {
  /** The cover's URL, or `null` where this caller has no cover to be shown. */
  src: string | null;
  /** The repository's tile, drawn behind the image — see `cardCover`. */
  pattern: string;
}

/**
 * A card's cover. The tile travels whether or not there is an image: the server
 * knows the cover resolves for this caller and nothing more, and the browser is
 * what finds out the bytes do not arrive.
 */
export function cardCover(
  repo: CoverRepo,
  base: string,
  coverPath: string | null,
  id: string,
): ReaderCover {
  return {
    src: coverPath === null ? null : `${base}/${coverPath}`,
    pattern: renderCoverPattern(coverKey(repo), id),
  };
}

/**
 * The landing page's cover, or `null`.
 *
 * Unlike a card, a page with no cover draws *nothing*. A tile is the card's answer
 * to "this repository has no picture" — a grid of cards is a set to recognise
 * things in, and one empty box in it reads as a broken instance. A page needs no
 * such answer, and a generated pattern over an article is decoration its author
 * never asked for. So the tile is here only as the fallback for an image that
 * fails, which is the one case where something is already expected.
 */
export function landingCover(
  repo: CoverRepo,
  base: string,
  coverPath: string | null,
): ReaderCover | null {
  if (coverPath === null) return null;
  return cardCover(repo, base, coverPath, 'spr-cover-page');
}
