/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BUNDLE = (() => {
  const dir = join(__dirname, '../../dist/client');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<
    string,
    string
  >;
  return readFileSync(join(dir, manifest.tree), 'utf8');
})();

function tree(currentPath = 'guides/one'): string {
  const open = (path: string, isOpen: boolean, children: string) => `
    <li class="spr-nav-branch">
      <div class="spr-nav-row">
        <a href="/repo/${path}" data-tree-link><span>${path}</span></a>
        <button type="button" class="spr-nav-toggle" aria-expanded="${isOpen}"
                aria-controls="tree-${path}" aria-label="${isOpen ? 'Collapse' : 'Expand'} ${path}"
                data-tree-toggle="${path}"></button>
      </div>
      <ul id="tree-${path}" data-tree-group="${path}"${isOpen ? '' : ' hidden'}>${children}</ul>
    </li>`;
  const leaf = (path: string) =>
    `<li class="spr-nav-leaf"><a href="/repo/${path}"${
      path === currentPath ? ' aria-current="page"' : ''
    } data-tree-link><span>${path}</span></a></li>`;

  return `
    <svg hidden><symbol id="i-book-open"><path d="M1 1"/></symbol></svg>
    <header class="spr-header">
      <details class="spr-account" open>
        <summary aria-label="Account — Alice"><span class="spr-avatar">A</span></summary>
        <div class="spr-account-menu">
          <a class="spr-account-item" href="/-/status" data-spr-load="full">Dashboard</a>
        </div>
      </details>
      <a class="spr-signin" href="/api/auth/login?redirect_to=%2Frepo%2Fguides%2Fone"
         data-spr-signin data-spr-load="full">Sign in</a>
      <details class="spr-menu" open><summary aria-label="Menu"></summary></details>
    </header>
    <div class="spr-menu-account">
      <a class="spr-signin" href="/api/auth/login?redirect_to=%2Frepo%2Fguides%2Fone"
         data-spr-signin data-spr-load="full">Sign in</a>
    </div>
    <div class="spr-layout" data-tree data-spr-tree="/repo">
      <nav class="spr-nav">
        <ul class="spr-nav-root spr-nav-tree">
          ${open('guides', true, leaf('guides/one') + leaf('guides/two'))}
          ${open('archive', false, leaf('archive/old'))}
        </ul>
      </nav>
      <main><h1>One</h1></main>
    </div>`;
}

function load(): void {
  document.body.innerHTML = tree();
  // eslint-disable-next-line no-new-func
  new Function(BUNDLE)();
}

const toggleFor = (path: string) =>
  document.querySelector<HTMLElement>(`[data-tree-toggle="${path}"]`)!;
const groupFor = (path: string) => document.getElementById(`tree-${path}`)!;

beforeEach(() => {
  sessionStorage.clear();
  jest.restoreAllMocks();
  // jsdom has no `animate`; a spec that stubs one must not leave it for the rest.
  delete (Element.prototype as Partial<Element>).animate;
  Element.prototype.scrollIntoView = jest.fn();
  Element.prototype.scrollTo = jest.fn();
  window.scrollTo = jest.fn();
  document.title = 'One';
  history.replaceState(null, '', '/');
  document.documentElement.removeAttribute('style');
  document.cookie = 'speicher_nav_width=; path=/; max-age=0';
});

describe('toggling', () => {
  it('opens a closed folder without navigating', () => {
    load();
    expect(groupFor('archive').hasAttribute('hidden')).toBe(true);

    toggleFor('archive').click();

    expect(toggleFor('archive').getAttribute('aria-expanded')).toBe('true');
    expect(groupFor('archive').hasAttribute('hidden')).toBe(false);
    expect(location.pathname).toBe('/');
  });

  it('closes an open folder', () => {
    load();
    toggleFor('guides').click();
    expect(toggleFor('guides').getAttribute('aria-expanded')).toBe('false');
    expect(groupFor('guides').hasAttribute('hidden')).toBe(true);
  });

  it('closes an open folder from its label, without navigating', () => {
    load();
    globalThis.fetch = jest.fn() as unknown as typeof fetch;

    document.querySelector<HTMLAnchorElement>('a[href="/repo/guides"]')!.click();

    expect(toggleFor('guides').getAttribute('aria-expanded')).toBe('false');
    expect(groupFor('guides').hasAttribute('hidden')).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(location.pathname).toBe('/');
  });

  it('takes an open folder with an index page there first, rather than closing it', async () => {
    load();
    const link = document.querySelector<HTMLAnchorElement>('a[href="/repo/guides"]')!;
    link.setAttribute('data-tree-index', '');
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        url: 'http://localhost/repo/guides',
        headers: { get: () => 'application/json' },
        json: async () => ({
          title: 'Guides',
          html: '<h1>Guides</h1>',
          symbols: '',
          tree: '/repo',
        }),
      } as unknown as Response),
    ) as unknown as typeof fetch;

    link.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(globalThis.fetch).toHaveBeenCalled();
    expect(location.pathname).toBe('/repo/guides');
    expect(toggleFor('guides').getAttribute('aria-expanded')).toBe('true');

    // Now on the index page, the same click closes it.
    (globalThis.fetch as jest.Mock).mockClear();
    link.click();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(toggleFor('guides').getAttribute('aria-expanded')).toBe('false');
  });

  it('treats a click on the bare end of a folder\u2019s row as one on its label', () => {
    load();
    globalThis.fetch = jest.fn() as unknown as typeof fetch;

    toggleFor('guides').parentElement!.click();

    expect(toggleFor('guides').getAttribute('aria-expanded')).toBe('false');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('slides a folder shut, and hides it only once the slide has finished', () => {
    const slide = { cancel: jest.fn(), onfinish: null as null | (() => void) };
    const animate = jest.fn(() => slide);
    Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
    window.matchMedia = jest.fn(() => ({ matches: false })) as unknown as typeof matchMedia;
    load();

    toggleFor('guides').click();

    expect(animate).toHaveBeenCalledTimes(1);
    const [keyframes] = animate.mock.calls[0] as unknown as [Keyframe[]];
    expect(keyframes[keyframes.length - 1]).toMatchObject({ height: '0px' });
    // Still drawn while it shrinks; the state the reader sees is already "closed".
    expect(groupFor('guides').hasAttribute('hidden')).toBe(false);
    expect(toggleFor('guides').getAttribute('aria-expanded')).toBe('false');

    slide.onfinish!();
    expect(groupFor('guides').hasAttribute('hidden')).toBe(true);
  });

  it('slides a closed folder open as its label is clicked, not when the page arrives', () => {
    const slide = { cancel: jest.fn(), onfinish: null as null | (() => void) };
    const animate = jest.fn(() => slide);
    Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
    window.matchMedia = jest.fn(() => ({ matches: false })) as unknown as typeof matchMedia;
    globalThis.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    load();

    document.querySelector<HTMLAnchorElement>('a[href="/repo/archive"]')!.click();

    expect(globalThis.fetch).toHaveBeenCalled();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(toggleFor('archive').getAttribute('aria-expanded')).toBe('true');
    expect(groupFor('archive').hasAttribute('hidden')).toBe(false);
  });

  it('lets the slide finish when the page arrives during it', async () => {
    const slide = { cancel: jest.fn(), onfinish: null as null | (() => void) };
    Element.prototype.animate = jest.fn(() => slide) as unknown as typeof Element.prototype.animate;
    window.matchMedia = jest.fn(() => ({ matches: false })) as unknown as typeof matchMedia;
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        url: 'http://localhost/repo/archive',
        headers: { get: () => 'application/json' },
        json: async () => ({
          title: 'Archive',
          html: '<h1>Archive</h1>',
          symbols: '',
          tree: '/repo',
        }),
      } as unknown as Response),
    ) as unknown as typeof fetch;
    load();

    document.querySelector<HTMLAnchorElement>('a[href="/repo/archive"]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(location.pathname).toBe('/repo/archive');
    expect(slide.cancel).not.toHaveBeenCalled();
  });

  it('slides a collapsible section in the article, and closes it once the slide ends', () => {
    const slide = { cancel: jest.fn(), onfinish: null as null | (() => void) };
    const animate = jest.fn(() => slide);
    Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
    window.matchMedia = jest.fn(() => ({ matches: false })) as unknown as typeof matchMedia;
    load();
    document.querySelector('main')!.innerHTML =
      '<div class="spr-article"><details><summary>More</summary><p>Body</p></details></div>';
    // The fixture's account menu is a `<details>` too, and must not be the one found.
    const details = document.querySelector<HTMLDetailsElement>('.spr-article details')!;

    details.querySelector('summary')!.click();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(details.open).toBe(true);
    slide.onfinish!();

    details.querySelector('summary')!.click();
    expect(animate).toHaveBeenCalledTimes(2);
    // Still drawn while it shrinks, with the arrow already turned back.
    expect(details.open).toBe(true);
    expect(details.hasAttribute('data-spr-closing')).toBe(true);
    slide.onfinish!();
    expect(details.open).toBe(false);
    expect(details.hasAttribute('data-spr-closing')).toBe(false);
  });

  it('does not slide for a reader who asked for reduced motion', () => {
    const animate = jest.fn();
    Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
    window.matchMedia = jest.fn(() => ({ matches: true })) as unknown as typeof matchMedia;
    load();

    toggleFor('guides').click();

    expect(animate).not.toHaveBeenCalled();
    expect(groupFor('guides').hasAttribute('hidden')).toBe(true);
  });

  it('keeps the accessible label in step with the state', () => {
    load();
    expect(toggleFor('archive').getAttribute('aria-label')).toBe('Expand archive');
    toggleFor('archive').click();
    expect(toggleFor('archive').getAttribute('aria-label')).toBe('Collapse archive');
  });

  it('hides children with `hidden`, so they leave the accessibility tree', () => {
    load();
    toggleFor('guides').click();
    expect(groupFor('guides').hasAttribute('hidden')).toBe(true);
  });
});

describe('remembering state', () => {
  it('records open folders per tab', () => {
    load();
    toggleFor('archive').click();
    const stored = JSON.parse(sessionStorage.getItem('speicher.tree.open') ?? '[]') as string[];
    expect(stored.sort()).toEqual(['archive', 'guides']);
  });

  it('restores them on the next load', () => {
    sessionStorage.setItem('speicher.tree.open', JSON.stringify(['archive']));
    load();
    expect(toggleFor('archive').getAttribute('aria-expanded')).toBe('true');
    expect(groupFor('archive').hasAttribute('hidden')).toBe(false);
  });

  it('is additive, so it never closes the branch you are looking at', () => {
    sessionStorage.setItem('speicher.tree.open', JSON.stringify(['archive']));
    load();
    expect(toggleFor('guides').getAttribute('aria-expanded')).toBe('true');
  });

  it('survives storage being unavailable', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    load();
    expect(() => toggleFor('archive').click()).not.toThrow();
    expect(toggleFor('archive').getAttribute('aria-expanded')).toBe('true');
  });

  it('ignores corrupt stored state', () => {
    sessionStorage.setItem('speicher.tree.open', 'not json');
    expect(() => load()).not.toThrow();
    expect(toggleFor('archive').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('resizing the tree', () => {
  const handle = () => document.querySelector<HTMLElement>('.spr-nav-resize')!;
  const width = () => document.documentElement.style.getPropertyValue('--spr-nav-user');

  const pointer = (type: string, clientX: number, target: EventTarget = window) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));

  const press = (key: string) =>
    handle().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  it('puts a divider after the tree, where tabbing out of it will reach', () => {
    load();
    expect(handle()).not.toBeNull();
    expect(handle().previousElementSibling).toBe(document.querySelector('nav.spr-nav'));
    expect(handle().getAttribute('role')).toBe('separator');
    expect(handle().getAttribute('aria-orientation')).toBe('vertical');
    expect(handle().tabIndex).toBe(0);
    expect(handle().getAttribute('aria-controls')).toBe(document.querySelector('nav.spr-nav')!.id);
  });

  it('adds nothing to a page with no tree', () => {
    document.body.innerHTML = '<div class="spr-layout"><main><h1>Speicher</h1></main></div>';
    // eslint-disable-next-line no-new-func
    new Function(BUNDLE)();
    expect(document.querySelector('.spr-nav-resize')).toBeNull();
  });

  it('follows the pointer, and writes the width where the sheet reads it', () => {
    load();
    pointer('pointerdown', 272, handle());
    pointer('pointermove', 240);
    expect(width()).toBe('240px');
    expect(document.documentElement.hasAttribute('data-spr-resizing')).toBe(true);

    pointer('pointerup', 240);
    expect(document.documentElement.hasAttribute('data-spr-resizing')).toBe(false);
    pointer('pointermove', 400);
    expect(width()).toBe('240px');
  });

  it('stores the width in a cookie, so the server can render it', () => {
    load();
    pointer('pointerdown', 272, handle());
    pointer('pointermove', 300);
    pointer('pointerup', 300);
    expect(document.cookie).toContain('speicher_nav_width=300');
  });

  it('moves by a rem from the keyboard', () => {
    load();
    document.documentElement.style.setProperty('--spr-nav-user', '200px');
    press('ArrowRight');
    expect(width()).toBe('216px');
    press('ArrowLeft');
    expect(width()).toBe('200px');
    expect(document.cookie).toContain('speicher_nav_width=200');
  });

  it('reaches the bounds by asking for values outside them', () => {
    load();
    const layout = document.querySelector('.spr-layout')!;
    jest
      .spyOn(layout, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, width: 1200 } as DOMRect);

    press('Home');
    expect(width()).toBe('0px');
    press('End');
    expect(width()).toBe('1200px');
  });

  it('ignores keys that are not its own', () => {
    load();
    document.documentElement.style.setProperty('--spr-nav-user', '200px');
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    handle().dispatchEvent(event);
    expect(width()).toBe('200px');
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('fragment navigation', () => {
  const fragment = (
    body: Partial<{ title: string; html: string; symbols: string; tree: string }>,
  ) =>
    Promise.resolve({
      ok: true,
      url: 'http://localhost/repo/guides/two',
      headers: { get: () => 'application/json' },
      json: async () => ({
        title: 'Two',
        html: '<h1>Two</h1>',
        symbols: '',
        tree: '/repo',
        ...body,
      }),
    } as unknown as Response);

  it('swaps the content and the title instead of loading a page', async () => {
    load();
    const fetchMock = jest.fn(() => fragment({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    document.querySelector<HTMLAnchorElement>('a[href="/repo/guides/two"]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/repo/guides/two',
      expect.objectContaining({ headers: { 'X-Speicher-Fragment': '1' } }),
    );
    expect(document.querySelector('main')!.innerHTML).toBe('<h1>Two</h1>');
    expect(document.title).toBe('Two');
  });

  it('leaves the tree in the DOM, which is why its state survives', async () => {
    load();
    toggleFor('archive').click();
    globalThis.fetch = jest.fn(() => fragment({})) as unknown as typeof fetch;

    document.querySelector<HTMLAnchorElement>('a[href="/repo/guides/two"]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(toggleFor('archive').getAttribute('aria-expanded')).toBe('true');
  });

  it('merges in symbols the new content needs, and only those', async () => {
    load();
    globalThis.fetch = jest.fn(() =>
      fragment({
        symbols:
          '<symbol id="i-book-open"><path d="M9 9"/></symbol><symbol id="i-wrench"><path d="M2 2"/></symbol>',
      }),
    ) as unknown as typeof fetch;

    document.querySelector<HTMLAnchorElement>('a[href="/repo/guides/two"]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.getElementById('i-wrench')).not.toBeNull();
    expect(document.querySelectorAll('#i-book-open')).toHaveLength(1);
  });

  it('moves the current marker to the new page', async () => {
    load();
    globalThis.fetch = jest.fn(() => fragment({})) as unknown as typeof fetch;

    document.querySelector<HTMLAnchorElement>('a[href="/repo/guides/two"]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(
      document
        .querySelector<HTMLAnchorElement>('a[href="/repo/guides/two"]')!
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('opens the folder it navigated to, as a full page load would have', async () => {
    load();
    expect(groupFor('archive').hasAttribute('hidden')).toBe(true);
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        url: 'http://localhost/repo/archive',
        headers: { get: () => 'application/json' },
        json: async () => ({
          title: 'Archive',
          html: '<h1>Archive</h1>',
          symbols: '',
          tree: '/repo',
        }),
      } as unknown as Response),
    ) as unknown as typeof fetch;

    document.querySelector<HTMLAnchorElement>('a[href="/repo/archive"]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(toggleFor('archive').getAttribute('aria-expanded')).toBe('true');
    expect(groupFor('archive').hasAttribute('hidden')).toBe(false);
    expect(JSON.parse(sessionStorage.getItem('speicher.tree.open')!)).toEqual(
      expect.arrayContaining(['archive']),
    );
  });

  it('hands anything that is not a fragment back to the browser', async () => {
    load();
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, headers: { get: () => null } } as unknown as Response),
    ) as unknown as typeof fetch;

    document.querySelector<HTMLAnchorElement>('a[href="/repo/guides/two"]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('main')!.innerHTML).toBe('<h1>One</h1>');
    expect(document.title).not.toBe('Two');
  });

  // The swap keeps the tree, so crossing into another repository would leave this
  // one's tree beside that one's page with nothing current. What a full page load
  // would draw is the destination's tree, so the browser is asked to draw it.
  it('hands a page from another repository back to the browser', async () => {
    load();
    globalThis.fetch = jest.fn(() => fragment({ tree: '/other' })) as unknown as typeof fetch;

    document.querySelector<HTMLAnchorElement>('a[href="/repo/guides/two"]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('main')!.innerHTML).toBe('<h1>One</h1>');
    expect(document.title).not.toBe('Two');
    expect(location.pathname).not.toBe('/repo/guides/two');
  });

  it('leaves the chrome links to the browser', async () => {
    load();
    const fetchMock = jest.fn(() => fragment({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    document.querySelector<HTMLAnchorElement>('a[href="/-/status"]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('closes the account menu, which a full page load would have done', async () => {
    load();
    globalThis.fetch = jest.fn(() => fragment({})) as unknown as typeof fetch;
    expect(document.querySelector('details.spr-account')!.hasAttribute('open')).toBe(true);

    document.querySelector<HTMLAnchorElement>('a[href="/repo/guides/two"]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('details.spr-account')!.hasAttribute('open')).toBe(false);
  });

  // A reader who picked a page from the phone menu wants the page, not the menu.
  it('closes the phone menu too', async () => {
    load();
    globalThis.fetch = jest.fn(() => fragment({})) as unknown as typeof fetch;
    expect(document.querySelector('details.spr-menu')!.hasAttribute('open')).toBe(true);

    document.querySelector<HTMLAnchorElement>('a[href="/repo/guides/two"]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('details.spr-menu')!.hasAttribute('open')).toBe(false);
  });

  it('points the sign-in button at where the reader got to', async () => {
    load();
    globalThis.fetch = jest.fn(() => fragment({})) as unknown as typeof fetch;

    document.querySelector<HTMLAnchorElement>('a[href="/repo/guides/two"]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    // Both of them: the phone menu carries its own copy of the button.
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-spr-signin]'));
    expect(links).toHaveLength(2);
    for (const { href } of links) {
      expect(new URL(href).searchParams.get('redirect_to')).toBe('/repo/guides/two');
      expect(new URL(href).pathname).toBe('/api/auth/login');
    }
  });

  it('does not let a slow navigation overwrite a newer one', async () => {
    load();
    const slow = { ...(await fragment({ title: 'Slow', html: '<h1>Slow</h1>' })) };
    let releaseSlow: () => void = () => {};
    globalThis.fetch = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSlow = () => resolve(slow as unknown as Response);
          }),
      )
      .mockImplementationOnce(() =>
        fragment({ title: 'Fast', html: '<h1>Fast</h1>' }),
      ) as unknown as typeof fetch;

    document.querySelector<HTMLAnchorElement>('a[href="/repo/guides/two"]')!.click();
    document.querySelector<HTMLAnchorElement>('a[href="/repo/guides/one"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    releaseSlow();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('main')!.innerHTML).toBe('<h1>Fast</h1>');
  });

  it('falls back to the browser when the request fails outright', async () => {
    load();
    globalThis.fetch = jest.fn(() =>
      Promise.reject(new Error('offline')),
    ) as unknown as typeof fetch;

    document.querySelector<HTMLAnchorElement>('a[href="/repo/guides/two"]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('main')!.innerHTML).toBe('<h1>One</h1>');
  });
});

describe('in-page anchors', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    load();
    document.querySelector('main')!.innerHTML =
      '<h1>One</h1><a href="#control-plane">jump</a><h2 id="control-plane">Control plane</h2>';
    fetchMock = jest.fn(() => Promise.reject(new Error('should not be called')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('leaves a same-page anchor entirely to the browser', () => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.querySelector<HTMLAnchorElement>('a[href="#control-plane"]')!.dispatchEvent(event);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves a link carrying a text directive to the browser', () => {
    document.querySelector('main')!.innerHTML =
      '<a href="/repo/guides/two#:~:text=every-,grant,-narrows">go</a>';
    let leftToBrowser: boolean | null = null;
    const observe = (event: Event) => {
      leftToBrowser = !event.defaultPrevented;
      event.preventDefault();
    };
    window.addEventListener('click', observe);
    document.querySelector<HTMLAnchorElement>('main a')!.click();
    window.removeEventListener('click', observe);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(leftToBrowser).toBe(true);
  });

  it('still intercepts a link to another page that carries an anchor', async () => {
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        url: 'http://localhost/repo/guides/two',
        headers: { get: () => 'application/json' },
        json: async () => ({
          title: 'Two',
          html: '<h1>Two</h1><h2 id="deep">Deep</h2>',
          symbols: '',
          tree: '/repo',
        }),
      } as unknown as Response),
    ) as unknown as typeof fetch;

    document.querySelector('main')!.innerHTML = '<a href="/repo/guides/two#deep">go</a>';
    document.querySelector<HTMLAnchorElement>('main a')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('main')!.innerHTML).toContain('id="deep"');
    expect(location.hash).toBe('#deep');
    expect(document.activeElement?.id).toBe('deep');
  });

  it('lands at the top when the destination has no anchor', async () => {
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        url: 'http://localhost/repo/guides/two',
        headers: { get: () => 'application/json' },
        json: async () => ({ title: 'Two', html: '<h1>Two</h1>', symbols: '', tree: '/repo' }),
      } as unknown as Response),
    ) as unknown as typeof fetch;

    document.querySelector('main')!.innerHTML = '<a href="/repo/guides/two">go</a>';
    document.querySelector<HTMLAnchorElement>('main a')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.activeElement?.tagName).toBe('MAIN');
  });
});

describe('links the island must not intercept', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    load();
    fetchMock = jest.fn(() => Promise.reject(new Error('should not be called')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  const clickWith = (selector: string, init: MouseEventInit = {}) => {
    const el = document.querySelector<HTMLElement>(selector)!;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  };

  it('leaves modified clicks to the browser', () => {
    for (const init of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
    ]) {
      clickWith('a[href="/repo/guides/two"]', init);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves middle clicks to the browser', () => {
    clickWith('a[href="/repo/guides/two"]', { button: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves cross-origin links alone', () => {
    document.querySelector('main')!.innerHTML = '<a href="https://example.test/x">out</a>';
    clickWith('main a');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves asset links to the browser', () => {
    document.querySelector('main')!.innerHTML = '<a href="/repo/images/chart.png">chart</a>';
    clickWith('main a');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves download links to the browser', () => {
    document.querySelector('main')!.innerHTML = '<a href="/repo/thing" download>get</a>';
    clickWith('main a');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
