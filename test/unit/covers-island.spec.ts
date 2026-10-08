/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const bundle = (island: string): string => {
  const dir = join(__dirname, '../../dist/client');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<
    string,
    string
  >;
  return readFileSync(join(dir, manifest[island]), 'utf8');
};

const BUNDLE = bundle('covers');
/** The reader's bundle, which carries this upgrade for the landing page's cover. */
const TREE = bundle('tree');

const TILE = '<svg class="spr-cover-art" aria-hidden="true"><rect/></svg>';

function card(name: string, withCover: boolean): string {
  const img = withCover ? `<img src="/${name}/_repo/cover.png" alt="" loading="lazy">` : '';
  return `<li class="spr-repo" data-repo="${name}"><a href="/${name}"><span class="spr-cover">${img}${TILE}</span></a></li>`;
}

function mount(): void {
  // eslint-disable-next-line no-new-func
  new Function(BUNDLE)();
}

const cover = (name: string) => document.querySelector(`[data-repo="${name}"] .spr-cover`)!;
const hasImage = (name: string) => cover(name).querySelector('img') !== null;
const hasTile = (name: string) => cover(name).querySelector('.spr-cover-art') !== null;

function settle(img: HTMLImageElement, naturalWidth: number): void {
  Object.defineProperty(img, 'complete', { value: true });
  Object.defineProperty(img, 'naturalWidth', { value: naturalWidth });
}

beforeEach(() => {
  document.body.innerHTML = `<main><ul class="spr-repos">${card('handbook', true)}${card('specs', true)}${card('fieldkit', false)}</ul></main>`;
});

describe('the covers island', () => {
  it('removes an image that fails after the island mounted, leaving the tile', () => {
    mount();
    const img = cover('handbook').querySelector('img')!;
    img.dispatchEvent(new Event('error'));
    expect(hasImage('handbook')).toBe(false);
    expect(hasTile('handbook')).toBe(true);
  });

  it('removes an image that had already failed before the island ran', () => {
    settle(cover('handbook').querySelector('img')!, 0);
    mount();
    expect(hasImage('handbook')).toBe(false);
    expect(hasTile('handbook')).toBe(true);
  });

  it('leaves an image that loaded alone', () => {
    settle(cover('handbook').querySelector('img')!, 640);
    mount();
    expect(hasImage('handbook')).toBe(true);
  });

  it('leaves an image still loading alone until it fails', () => {
    mount();
    expect(hasImage('specs')).toBe(true);
    expect(hasImage('handbook')).toBe(true);
  });

  it('touches only the card whose image failed', () => {
    mount();
    cover('handbook').querySelector('img')!.dispatchEvent(new Event('error'));
    expect(hasImage('specs')).toBe(true);
    expect(hasTile('specs')).toBe(true);
    expect(hasTile('fieldkit')).toBe(true);
  });

  it('runs on a page that has no covers at all', () => {
    document.body.innerHTML = '<main><p class="spr-empty">There is nothing here.</p></main>';
    expect(mount).not.toThrow();
  });
});

/**
 * The landing page's cover, run as it ships: inside `tree`, against the markup
 * `content-page.eta` stores. The fallback is the card's promise, so a repository
 * whose picture fails must not be a bordered empty box on its own front page.
 */
describe('the same upgrade on a repository landing page', () => {
  const page = (): void => {
    document.body.innerHTML =
      `<main class="spr-main"><div class="spr-article"><div class="spr-article-body">` +
      `<div data-repo="handbook"><span class="spr-cover spr-cover-page">` +
      `<img src="/handbook/_repo/cover.png" alt="">${TILE}</span></div><p>Body.</p>` +
      `</div></div></main>`;
  };

  it('leaves the tile behind when the cover fails', () => {
    page();
    // eslint-disable-next-line no-new-func
    new Function(TREE)();
    cover('handbook').querySelector('img')!.dispatchEvent(new Event('error'));
    expect(hasImage('handbook')).toBe(false);
    expect(hasTile('handbook')).toBe(true);
  });

  it('reads a cover that had already failed before the bundle ran', () => {
    page();
    settle(document.querySelector('img')!, 0);
    // eslint-disable-next-line no-new-func
    new Function(TREE)();
    expect(hasImage('handbook')).toBe(false);
    expect(hasTile('handbook')).toBe(true);
  });

  it('keeps a cover that arrived', () => {
    page();
    settle(document.querySelector('img')!, 960);
    // eslint-disable-next-line no-new-func
    new Function(TREE)();
    expect(hasImage('handbook')).toBe(true);
  });
});
