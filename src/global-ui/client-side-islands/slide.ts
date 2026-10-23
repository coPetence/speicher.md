/**
 * Animated slide toggle for `<details>` and persistence of nav fold state
 *
 * Intercepts clicks on a `<summary>` to animate the disclosure instead of the
 * browser's instant toggle
 *
 * Nav folds record their open/closed state in a cookie so the server can render
 * them pre-opened on the next page load
 */

import { mountResizer } from './resize';

export const SLIDE_MS = 150;

export function motionless(el: HTMLElement): boolean {
  return typeof el.animate !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const slides = new WeakMap<HTMLDetailsElement, { slide: Animation; opening: boolean }>();

export function slideDetails(details: HTMLDetailsElement): void {
  const running = slides.get(details);
  const opening = running ? !running.opening : !details.open;
  const from = details.getBoundingClientRect().height;
  running?.slide.cancel();

  details.open = false;
  const closed = details.getBoundingClientRect().height;
  details.open = true;
  const open = details.getBoundingClientRect().height;
  details.toggleAttribute('data-spr-closing', !opening);

  const slide = details.animate(
    [
      { height: `${from}px`, overflow: 'hidden' },
      { height: `${opening ? open : closed}px`, overflow: 'hidden' },
    ],
    { duration: SLIDE_MS, easing: 'ease' },
  );
  slides.set(details, { slide, opening });
  slide.onfinish = () => {
    slides.delete(details);
    details.removeAttribute('data-spr-closing');
    if (!opening) details.open = false;
  };
}

export function mountDetailsSlide(selector: string): void {
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const target = event.target as Element | null;
    const summary = target?.closest('summary');
    const details = summary?.parentElement;
    if (!(details instanceof HTMLDetailsElement) || !details.matches(selector)) return;
    if (summary !== details.querySelector(':scope > summary')) return;
    if (target?.closest('a[href]') || motionless(details)) return;

    event.preventDefault();
    slideDetails(details);
  });
}

const FOLDS_COOKIE = 'speicher_dashboard_open';

function writeFolds(folds: Iterable<HTMLDetailsElement>): void {
  const open = [...folds]
    .filter((fold) => fold.open && !fold.hasAttribute('data-spr-closing'))
    .map((fold) => fold.dataset.sprFold)
    .filter(Boolean);
  const secure = location.protocol === 'https:' ? '; secure' : '';
  document.cookie = `${FOLDS_COOKIE}=${encodeURIComponent(open.join(','))}; path=/-/; samesite=lax${secure}`;
}

export function mountNav(): void {
  mountResizer();

  const selector = '.spr-nav-fold';
  mountDetailsSlide(selector);

  const folds = () => document.querySelectorAll<HTMLDetailsElement>(selector);
  writeFolds(folds());

  document.addEventListener(
    'toggle',
    (event) => {
      if (event.target instanceof HTMLDetailsElement && event.target.matches(selector)) {
        writeFolds(folds());
      }
    },
    true,
  );
}
