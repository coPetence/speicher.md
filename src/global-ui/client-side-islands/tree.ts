/**
 * Navigation tree island
 *
 * Intercepts same-origin document links to fetch fragments instead of full pages
 * Persists expanded folders in sessionStorage so the tree survives fragment navigations
 * Initiates the other islands that need mounting — tabs, covers, code copy buttons,
 * peek, beacon, resizer, article details slides
 *
 * The server returns a Fragment (JSON with html, title, symbols) when the request
 * carries X-Speicher-Fragment.  The response tree must match the shell's repo or
 * the fragment is rejected
 *
 * Not a Service Worker: the page's own script stays live across navigations
 */

import { countFragment, mountBeacon } from './beacon';
import { mountCodeCopy } from './code-copy';
import { mountCovers } from './cover-tile';
import { mountHistorySteps } from './history-steps';
import { mountPeek } from './peek';
import { mountResizer } from './resize';
import { SLIDE_MS, motionless, mountDetailsSlide } from './slide';
import { mountTabs } from './tabs';

const STORAGE_KEY = 'speicher.tree.open'; // sessionStorage key for expanded folder paths
const FRAGMENT_HEADER = 'X-Speicher-Fragment'; // Request header that asks the server for a fragment

interface Fragment {
  title: string;
  html: string;
  symbols: string; // SVG <symbol> elements to merge into the sprite sheet

  countable?: boolean; // Whether the navigation counts as a page view

  tree?: string; // Repository path; must match the shell's data-spr-tree
}

function readOpen(): Set<string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    // Corrupt or unavailable storage: start with no remembered state
    return new Set();
  }
}

function writeOpen(open: Set<string>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...open]));
  } catch {
    // Private browsing or full storage: state is lost but navigation still works
  }
}

const slides = new WeakMap<HTMLElement, { slide: Animation; expanded: boolean }>();

function showGroup(group: HTMLElement, expanded: boolean, animate: boolean): void {
  const still = !animate || motionless(group);
  const running = slides.get(group);
  if (still) {
    // When the target state matches a running animation, skip to avoid flicker
    if (running?.expanded === expanded) return;
    running?.slide.cancel();
    slides.delete(group);
    group.toggleAttribute('hidden', !expanded);
    return;
  }

  const from = group.hidden ? 0 : group.getBoundingClientRect().height;
  running?.slide.cancel();
  group.hidden = false;
  const to = expanded ? group.getBoundingClientRect().height : 0;

  const slide = group.animate(
    [
      { height: `${from}px`, overflow: 'hidden' },
      { height: `${to}px`, overflow: 'hidden' },
    ],
    { duration: SLIDE_MS, easing: 'ease' },
  );
  slides.set(group, { slide, expanded });
  slide.onfinish = () => {
    slides.delete(group);
    if (!expanded) group.hidden = true;
  };
}

function setExpanded(toggle: HTMLElement, expanded: boolean, animate = false): void {
  const group = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
  if (!group) return;
  toggle.setAttribute('aria-expanded', String(expanded));
  showGroup(group, expanded, animate);

  const label = toggle.getAttribute('aria-label') ?? '';
  toggle.setAttribute(
    'aria-label',
    label.replace(/^(Expand|Collapse)\b/, expanded ? 'Collapse' : 'Expand'),
  );
}

function applyStoredState(root: ParentNode): void {
  const open = readOpen();
  if (open.size === 0) return;
  for (const toggle of root.querySelectorAll<HTMLElement>('[data-tree-toggle]')) {
    const path = toggle.getAttribute('data-tree-toggle') ?? '';
    if (open.has(path) && toggle.getAttribute('aria-expanded') !== 'true') {
      setExpanded(toggle, true);
    }
  }
}

function recordState(nav: ParentNode): void {
  const open = new Set<string>();
  for (const toggle of nav.querySelectorAll<HTMLElement>('[data-tree-toggle]')) {
    if (toggle.getAttribute('aria-expanded') === 'true') {
      open.add(toggle.getAttribute('data-tree-toggle') ?? '');
    }
  }
  writeOpen(open);
}

function sameOriginDocument(link: HTMLAnchorElement): boolean {
  if (link.origin !== location.origin) return false;
  if (link.hasAttribute('download') || link.target) return false;
  // Links marked for full-page load (dashboard, settings, sign-in) bypass fragments
  if (link.dataset.sprLoad === 'full') return false;
  // Same-page anchors scroll natively
  if (link.hash && link.pathname === location.pathname && link.search === location.search) {
    return false;
  }
  // Text fragment directives are a browser-native feature
  if (link.hash.startsWith('#:~:')) return false;
  // Asset extensions (images, PDFs, etc.) must be full page loads
  return !/\.[a-z0-9]{2,5}$/i.test(link.pathname);
}

let navigationToken = 0;

async function navigate(url: string, push: boolean): Promise<boolean> {
  const main = document.querySelector('main');
  if (!main) return false;

  const token = ++navigationToken;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { [FRAGMENT_HEADER]: '1' },
      credentials: 'same-origin',
      redirect: 'follow',
    });
  } catch {
    return false;
  }

  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    return false;
  }
  // A newer navigation started while this one was in flight; discard the response
  if (token !== navigationToken) return true;

  const fragment = (await response.json()) as Fragment;
  // Only accept a fragment from the same repository as the current shell
  const shell = document.querySelector<HTMLElement>('.spr-layout');
  if (fragment.tree !== shell?.dataset.sprTree) return false;
  main.innerHTML = fragment.html;
  document.title = fragment.title;
  mergeSymbols(fragment.symbols);
  // Mount islands on the newly injected content
  mountTabs(main);
  mountCovers(main);
  mountCodeCopy(main);

  const destination = new URL(response.url);
  const wanted = new URL(url, location.href);
  if (!destination.hash && wanted.hash) destination.hash = wanted.hash;

  if (push) history.pushState({ speicher: true }, '', destination.href);
  mountHistorySteps(main);
  // Dispatch analytics, update nav highlights, close menus, focus content
  countFragment(fragment.countable === true);
  markCurrent(destination.pathname);
  refreshHeader(destination);

  focusDestination(main, destination.hash);
  return true;
}

function refreshHeader(destination: URL): void {
  // Close account and phone menus as a full page load would
  document.querySelector('details.spr-account')?.removeAttribute('open');
  document.querySelector('details.spr-menu')?.removeAttribute('open');

  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-spr-signin]')) {
    const target = new URL(link.href);
    target.searchParams.set('redirect_to', destination.pathname);
    link.href = target.href;
  }
}

function focusDestination(main: HTMLElement, hash: string): void {
  const id = hash ? decodeURIComponent(hash.slice(1)) : '';
  const target = id ? document.getElementById(id) : null;

  if (target) {
    // The target may be a plain element without tabindex; make it focusable
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    target.scrollIntoView();
    return;
  }

  main.setAttribute('tabindex', '-1');
  main.focus({ preventScroll: true });
  // Scroll to top when no hash target exists
  main.scrollTo(0, 0);
  window.scrollTo(0, 0);
}

function mergeSymbols(symbols: string): void {
  if (!symbols) return;
  const sprite = document.querySelector('svg[hidden]');
  if (!sprite) return;
  const parsed = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${symbols}</svg>`,
    'image/svg+xml',
  );
  for (const symbol of Array.from(parsed.documentElement.children)) {
    if (symbol.id && !document.getElementById(symbol.id)) {
      sprite.appendChild(document.importNode(symbol, true));
    }
  }
}

function markCurrent(pathname: string): void {
  const nav = document.querySelector('nav.spr-nav');
  if (!nav) return;
  for (const link of nav.querySelectorAll<HTMLAnchorElement>('a[aria-current]')) {
    link.removeAttribute('aria-current');
  }

  const wanted = pathname.replace(/\/$/, '');
  let target: HTMLAnchorElement | null = null;
  for (const link of nav.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (link.pathname.replace(/\/$/, '') === wanted) {
      target = link;
      break;
    }
  }
  if (!target) return;
  target.setAttribute('aria-current', 'page');
  // Expand the folder containing the current page
  const own = target.closest('.spr-nav-row')?.querySelector<HTMLElement>('[data-tree-toggle]');
  if (own) setExpanded(own, true);
  // Walk up the tree to expand any ancestor folders that were hidden
  for (let node: Element | null = target.parentElement; node; node = node.parentElement) {
    if (node.tagName !== 'UL' || !node.hasAttribute('hidden')) continue;
    const toggle = node.previousElementSibling?.querySelector<HTMLElement>('[data-tree-toggle]');
    if (toggle) setExpanded(toggle, true);
  }
  recordState(nav);
}

function start(): void {
  const nav = document.querySelector('nav.spr-nav');
  if (nav) applyStoredState(nav);
  mountResizer();
  // Other islands that must be running for the navigation to work
  mountPeek();
  mountBeacon();
  // Islands whose content may change between navigations
  mountDetailsSlide('.spr-article details');
  mountTabs();
  mountCovers();
  mountCodeCopy();
  mountHistorySteps();

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    // Modified clicks open in new tabs or windows; leave them to the browser
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const target = event.target as Element | null;

    // Click on the bare end of a tree row forwards to its label link
    if (target?.matches('.spr-nav-tree .spr-nav-row')) {
      event.preventDefault();
      target.querySelector<HTMLAnchorElement>(':scope > a')?.click();
      return;
    }

    const label = target?.closest('.spr-nav-row > a');
    const own = label?.parentElement?.querySelector<HTMLElement>('[data-tree-toggle]');
    // A folder label toggles the folder only if there is no index page, or we are on it
    const arrived =
      !label?.hasAttribute('data-tree-index') || label.getAttribute('aria-current') === 'page';
    const toggle =
      target?.closest<HTMLElement>('[data-tree-toggle]') ??
      (own?.getAttribute('aria-expanded') === 'true' && arrived ? own : null);
    if (toggle) {
      event.preventDefault();
      setExpanded(toggle, toggle.getAttribute('aria-expanded') !== 'true', true);
      const container = document.querySelector('nav.spr-nav');
      if (container) recordState(container);
      return;
    }

    const link = target?.closest<HTMLAnchorElement>('a[href]');
    if (!link || !sameOriginDocument(link)) return;

    event.preventDefault();
    // Open the folder before navigating to it, so the slide starts early
    if (link === label && own?.getAttribute('aria-expanded') === 'false') {
      setExpanded(own, true, true);
      const container = document.querySelector('nav.spr-nav');
      if (container) recordState(container);
    }

    void navigate(link.href, true).then((handled) => {
      if (!handled) location.href = link.href;
    });
  });

  addEventListener('popstate', () => {
    void navigate(location.href, false).then((handled) => {
      if (!handled) location.reload();
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
