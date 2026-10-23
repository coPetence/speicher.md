import type { Request } from 'express';

import { ResolvedCaller } from '../../src/authz/caller';
import type { ChromeConfig } from '../../src/content-reader/chrome';
import {
  accountChrome,
  brandMark,
  initialsOf,
  pageChrome,
  searchIcon,
  signInHref,
  wallpaperFor,
  wallpaperTokens,
} from '../../src/content-reader/chrome';
import { renderPage } from '../../src/global-ui/global-views/page-layout/page-layout';

function caller(over: Partial<ResolvedCaller> = {}): ResolvedCaller {
  return {
    tenantId: 't',
    identity: {
      provider: 'entra',
      subject: 'alice-oid',
      email: 'alice@copetence.test',
      displayName: 'Alice Ansell',
    },
    rawGroupIds: ['grp-eng'],
    viaBearer: false,
    principals: ['group:engineering'],
    internalGroups: ['engineering'],
    isAdmin: false,
    ...over,
  };
}

const CHROME = {
  themeTemplate: 'default',
  themeOverridesFor: () => null,
  brand: 'Acme Engineering Docs',
  brandLogoUrl: null,
  brandLogoDarkUrl: null,
  brandWallpaperUrl: null as string | null,
  brandWallpaperDarkUrl: null as string | null,
  faviconUrl: '/favicon.ico',
  faviconType: 'image/svg+xml',
  brandShowName: true,
  brandNameAlign: 'center' as const,
  attribution: true,
  hasContentSource: true,
};

function request(
  path: string,
  who: ResolvedCaller | undefined,
  cookies: Record<string, string> = {},
): Request {
  return { path, cookies, caller: who } as unknown as Request;
}

function header(
  path: string,
  who: ResolvedCaller | undefined,
  cookies: Record<string, string> = {},
): string {
  return renderPage('<h1>A page</h1>', {
    title: 'A page',
    nonce: 'test-nonce',
    ...pageChrome(request(path, who, cookies), CHROME),
  });
}

describe('a reader who is not signed in', () => {
  const html = header('/handbook/introduction', undefined);

  it('is offered a sign-in button and nothing else', () => {
    expect(html).toContain('class="spr-signin"');
    expect(html).not.toContain('spr-avatar');
    expect(html).not.toContain('/api/auth/logout');
  });

  it('is returned to the page they were on', () => {
    expect(html).toContain('redirect_to=%2Fhandbook%2Fintroduction');
  });
});

describe('a reader who is signed in', () => {
  const html = header('/handbook/introduction', caller());

  it('gets an avatar rather than a sign-in button', () => {
    expect(html).toContain('spr-avatar');
    expect(html).toContain('>AA<');
    expect(html).not.toContain('class="spr-signin"');
  });

  it('can sign out with no JavaScript at all', () => {
    expect(html).toContain('<details class="spr-account">');
    expect(html).toContain('<form class="spr-signout" method="post" action="/api/auth/logout">');
    expect(html).not.toContain('href="/api/auth/logout"');
  });

  it('is named in the menu, and by the control itself', () => {
    expect(html).toContain('Alice Ansell');
    expect(html).toContain('aria-label="Account — Alice Ansell"');
  });

  it('is not offered the dashboard', () => {
    expect(html).not.toContain('/-/status');
    expect(html).not.toContain('Dashboard');
  });
});

describe('the appearance control', () => {
  const html = header('/handbook/introduction', caller());

  it('is three answers, not a toggle between two', () => {
    expect(html).toContain('value="system"');
    expect(html).toContain('value="light"');
    expect(html).toContain('value="dark"');
  });

  it('works with no JavaScript, like everything else in this menu', () => {
    expect(html).toContain('<form class="spr-scheme" method="post" action="/api/appearance">');
  });

  it('says nothing about the page it is on', () => {
    expect(html).not.toContain('/handbook/introduction');
  });

  it('says which answer is in force, and never by appearance alone', () => {
    expect(html).toMatch(/value="system"\s+aria-pressed="true"/);
    expect(html).toMatch(/value="dark"\s+aria-pressed="false"/);

    const chosen = header('/', caller(), { speicher_theme: 'dark' });
    expect(chosen).toMatch(/value="dark"\s+aria-pressed="true"/);
    expect(chosen).toMatch(/value="system"\s+aria-pressed="false"/);
  });

  it('reaches the page as a stylesheet, so the first paint is already the answer', () => {
    const of = (cookies: Record<string, string>) =>
      pageChrome(request('/', caller(), cookies), CHROME).stylesheet ?? '';
    expect(of({ speicher_theme: 'dark' })).toContain('theme-dark-default');
    expect(of({ speicher_theme: 'light' })).toContain('theme-light-default');
    expect(of({})).toMatch(/theme-default-[0-9a-f]+\.css/);
    expect(of({ speicher_theme: '../evil' })).toMatch(/theme-default-[0-9a-f]+\.css/);
  });

  it('wears the instance template and palette on admin pages too', () => {
    const themed = {
      ...CHROME,
      themeTemplate: 'catppuccin',
      themeOverridesFor: () => ':root{--spr-accent:#123456}',
    };
    const chrome = pageChrome(request('/-/config/branding', caller({ isAdmin: true })), themed);
    expect(chrome.stylesheet).toMatch(/theme-catppuccin-[0-9a-f]+\.css/);
    expect(chrome.themeTokens).toContain('--spr-accent:#123456');
  });

  it('sets the wallpaper per scheme, and falls back to the light one in dark mode', () => {
    expect(wallpaperTokens(null, null, null)).toBeNull();

    const both = wallpaperTokens('/-/brand/a.jpg', '/-/brand/b.jpg', null);
    expect(both).toContain(
      '@media (prefers-color-scheme: light){:root{--spr-wallpaper:url("/-/brand/a.jpg")}}',
    );
    expect(both).toContain(
      '@media (prefers-color-scheme: dark){:root{--spr-wallpaper:url("/-/brand/b.jpg")}}',
    );

    expect(wallpaperTokens('/-/brand/a.jpg', null, 'dark')).toBe(
      ':root{--spr-wallpaper:url("/-/brand/a.jpg")}',
    );
    expect(wallpaperTokens(null, '/-/brand/b.jpg', 'light')).toBeNull();
  });

  it('gives Glass its own photos, no other template any, and lets an upload replace each', () => {
    const none = { brandWallpaperUrl: null, brandWallpaperDarkUrl: null };
    const glass = wallpaperFor(none, 'glass');
    expect(glass.light).toMatch(
      /^\/-\/static\/wallpaper-daniele-buso-qzUenL35ZYw-[0-9a-f]+\.webp$/,
    );
    expect(glass.dark).toMatch(
      /^\/-\/static\/wallpaper-benjamin-voros-phIFdC6lA4E-[0-9a-f]+\.webp$/,
    );

    expect(wallpaperFor(none, 'default')).toEqual({ light: null, dark: null });
    expect(wallpaperFor(none, 'catppuccin')).toEqual({ light: null, dark: null });

    const darkOnly = { brandWallpaperUrl: null, brandWallpaperDarkUrl: '/-/brand/b.jpg' };
    expect(wallpaperFor(darkOnly, 'glass')).toEqual({ light: glass.light, dark: '/-/brand/b.jpg' });

    const lightOnly = { brandWallpaperUrl: '/-/brand/a.jpg', brandWallpaperDarkUrl: null };
    expect(wallpaperFor(lightOnly, 'glass')).toEqual({ light: '/-/brand/a.jpg', dark: glass.dark });
    expect(wallpaperFor(lightOnly, 'default')).toEqual({
      light: '/-/brand/a.jpg',
      dark: '/-/brand/a.jpg',
    });
  });

  it('tells the layout a wallpaper is set, so the header and tree get a backing', () => {
    const page = (over: Partial<ChromeConfig>) =>
      renderPage('<h1>A page</h1>', {
        title: 'A page',
        nonce: 'test-nonce',
        ...pageChrome(request('/', caller()), { ...CHROME, ...over }),
      });
    expect(page({ brandWallpaperUrl: '/-/brand/a.jpg' })).toMatch(
      /<div class="spr-layout"[^>]* data-wallpaper>/,
    );
    expect(page({})).not.toContain('data-wallpaper');
  });

  it('is not drawn for a reader who has no account menu to draw it in', () => {
    expect(header('/', undefined)).not.toContain('/api/appearance');
  });
});

describe('an admin', () => {
  it('is offered the dashboard', () => {
    const html = header('/', caller({ isAdmin: true }));
    expect(html).toContain('Dashboard');
    expect(html).toContain('href="/-/status"');
  });

  it('reaches it with a full page load, not a fragment swap', () => {
    const html = header('/', caller({ isAdmin: true }));
    expect(html).toMatch(/href="\/-\/status" data-spr-load="full"/);
  });
});

describe('the marks beside the menu items', () => {
  it('draws one on each of the three items, inline rather than through the sprite', () => {
    const html = avatarMenu(header('/', caller({ isAdmin: true })));
    const items = [
      ...html.matchAll(/<(?:a|button) class="spr-account-item"[^>]*>(.*?)<\/(?:a|button)>/g),
    ];
    expect(items).toHaveLength(3);
    for (const [, inner] of items) {
      expect(inner).toMatch(/^<svg class="spr-icon"/);
      expect(inner).not.toContain('<use');
      expect(inner).toMatch(/<span>[^<]+<\/span>$/);
    }
  });

  it('is absent from the admin item for a reader who is not offered it', () => {
    const html = header('/', caller());
    expect(html).not.toContain('/-/status');
    expect([...avatarMenu(html).matchAll(/class="spr-account-item"/g)]).toHaveLength(2);
  });

  // The phone menu draws the same items again, where there is no avatar to hang a
  // dropdown from. One partial draws both, so they are the same list; the one
  // difference is the label's id, which must not be shared.
  it('offers the phone menu the very same items, under an id of its own', () => {
    for (const isAdmin of [true, false]) {
      const html = header('/', caller({ isAdmin }));
      const phone = /<div class="spr-menu-account">([\s\S]*?)<\/div>\s*<div class="spr-pane">/.exec(
        html,
      )?.[1];
      expect(phone).toBeDefined();
      const items = (fragment: string) =>
        [...fragment.matchAll(/class="spr-account-item"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g)].map(
          (m) => m[1],
        );
      expect(items(phone!)).toEqual(items(avatarMenu(html)));
      expect(phone).toContain('id="spr-appearance-menu"');
      expect([...html.matchAll(/id="spr-appearance"/g)]).toHaveLength(1);
    }
  });
});

/** The avatar's own dropdown, without the phone menu's copy of the same items */
function avatarMenu(html: string): string {
  return /<div class="spr-account-menu">[\s\S]*?<\/details>/.exec(html)?.[0] ?? '';
}

describe("the reader's own address", () => {
  it('carries the whole of it in a title, so what the ellipsis takes is still readable', () => {
    const html = header('/', caller());
    expect(html).toContain('<span title="alice@copetence.test">alice@copetence.test</span>');
  });

  it('is escaped in the title as well as in the text', () => {
    const html = header(
      '/',
      caller({
        identity: {
          provider: 'entra',
          subject: 'x',
          email: '"><script>fetch("//evil.test")</script>',
          displayName: 'Alice Ansell',
        },
      }),
    );
    expect(html).not.toContain('<script>fetch');
    expect(html).not.toContain('"><script');
  });
});

describe('a name the identity provider chose', () => {
  it('is escaped in the menu and in the control label', () => {
    const html = header(
      '/',
      caller({
        identity: {
          provider: 'entra',
          subject: 'x',
          email: null,
          displayName: '"><script>fetch("//evil.test")</script>',
        },
      }),
    );
    expect(html).not.toContain('<script>fetch');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('"><script');
  });
});

describe('accountChrome', () => {
  it('falls back from display name to address to subject', () => {
    const named = accountChrome(caller());
    expect(named?.name).toBe('Alice Ansell');

    const unnamed = accountChrome(
      caller({
        identity: { provider: 'entra', subject: 'bob-oid', email: 'bob@x.test', displayName: null },
      }),
    );
    expect(unnamed?.name).toBe('bob@x.test');

    const anonymousToItsProvider = accountChrome(
      caller({ identity: { provider: 'entra', subject: 'opaque-oid', email: null } }),
    );
    expect(anonymousToItsProvider?.name).toBe('opaque-oid');
  });

  it('is absent for nobody, and for a bearer caller', () => {
    expect(accountChrome(undefined)).toBeNull();
    expect(accountChrome(caller({ identity: null }))).toBeNull();
    expect(accountChrome(caller({ viaBearer: true }))).toBeNull();
  });

  it('carries the admin flag the caller already resolved', () => {
    expect(accountChrome(caller({ isAdmin: true }))?.isAdmin).toBe(true);
    expect(accountChrome(caller())?.isAdmin).toBe(false);
  });
});

describe('initials', () => {
  it('takes one letter per end of the name', () => {
    expect(initialsOf('Alice Ansell')).toBe('AA');
    expect(initialsOf('Jean-Luc Marie Picard')).toBe('JP');
    expect(initialsOf('Prince')).toBe('P');
  });

  it('uses the local part of an address, not the domain', () => {
    expect(initialsOf('bob.smith@copetence.test')).toBe('BS');
    expect(initialsOf('carol@northwind.test')).toBe('C');
  });

  it('counts code points, not UTF-16 units', () => {
    expect([...initialsOf('𝒜nna Björk')]).toHaveLength(2);
    expect(initialsOf('Ünal Öztürk')).toBe('ÜÖ');
  });

  it('always returns something', () => {
    expect(initialsOf('---')).toBe('?');
    expect(initialsOf('')).toBe('?');
  });
});

describe('where the sign-in button points', () => {
  it('carries the path', () => {
    expect(signInHref(request('/handbook/setup', undefined))).toBe(
      '/api/auth/login?redirect_to=%2Fhandbook%2Fsetup',
    );
  });

  it('never carries the query string', () => {
    const req = { path: '/handbook/setup', query: { evil: 'x'.repeat(40) } } as unknown as Request;
    expect(signInHref(req)).not.toContain('evil');
  });

  it('refuses a path that is really an origin', () => {
    expect(signInHref(request('//evil.example/', undefined))).toBe(
      '/api/auth/login?redirect_to=%2F',
    );
  });
});

describe('the brand in the header', () => {
  function brandAnchor(html: string): string {
    return /<a class="spr-brand" href="\/">([\s\S]*?)<\/a>/.exec(html)?.[1]?.trim() ?? '';
  }

  function brandText(html: string): string {
    return brandAnchor(html)
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  it('is the instance’s own name, linking home', () => {
    expect(brandText(header('/handbook/introduction', undefined))).toBe('Acme Engineering Docs');
  });

  it('does not name this product', () => {
    expect(brandText(header('/handbook/introduction', undefined))).not.toMatch(/speicher/i);
  });

  it('shows a neutral glyph when the instance has uploaded no logo', () => {
    const anchor = brandAnchor(header('/handbook/introduction', undefined));
    expect(anchor).toContain('class="spr-brand-mark"');
    expect(anchor).toContain('Acme Engineering Docs');
  });

  it('draws that glyph inline, and asks nobody for it', () => {
    const html = header('/handbook/introduction', undefined);
    const mark = /<svg class="spr-brand-mark"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
    expect(mark).not.toBe('');
    expect(mark).not.toContain('<use');
    expect(mark).not.toContain('src=');
    expect(mark).toContain('stroke="currentColor"');
    expect(mark).toContain('aria-hidden="true"');
  });

  it('is not this product’s mark either', () => {
    expect(brandMark()).not.toMatch(/speicher/i);
    expect(brandMark()).toContain('<svg');
  });

  function brandOpenTag(html: string): string {
    return /<a class="spr-brand" href="\/"[^>]*>/.exec(html)?.[0] ?? '';
  }

  function withLogo(showName: boolean, align: 'center' | 'bottom' = 'center'): string {
    return brandAnchor(
      renderPage('<h1>A page</h1>', {
        title: 'A page',
        nonce: 'test-nonce',
        ...pageChrome(request('/handbook/introduction', undefined), {
          ...CHROME,
          brandLogoUrl: '/-/brand/abc123.svg',
          brandShowName: showName,
          brandNameAlign: align,
        }),
      }),
    );
  }

  function openTagWith(over: Partial<ChromeConfig>): string {
    return brandOpenTag(
      renderPage('<h1>A page</h1>', {
        title: 'A page',
        nonce: 'test-nonce',
        ...pageChrome(request('/handbook/introduction', undefined), { ...CHROME, ...over }),
      }),
    );
  }

  it('wraps the name in its own element, so the sheet can keep it in one piece', () => {
    expect(withLogo(true)).toContain('<span class="spr-brand-name">Acme Engineering Docs</span>');
  });

  it('sets the name on the bottom edge of the logo when asked', () => {
    expect(
      openTagWith({ brandLogoUrl: '/-/brand/abc123.svg', brandNameAlign: 'bottom' }),
    ).toContain('data-align="bottom"');
  });

  it('centres the name on the logo by default', () => {
    expect(openTagWith({ brandLogoUrl: '/-/brand/abc123.svg' })).not.toContain('data-align');
  });

  it('ignores the alignment when there is no logo or no name beside it', () => {
    expect(openTagWith({ brandNameAlign: 'bottom' })).not.toContain('data-align');
    expect(
      openTagWith({
        brandLogoUrl: '/-/brand/abc123.svg',
        brandShowName: false,
        brandNameAlign: 'bottom',
      }),
    ).not.toContain('data-align');
  });

  it('keeps the name beside a logo, because a logo is often a symbol', () => {
    const anchor = withLogo(true);
    expect(anchor).toContain('src="/-/brand/abc123.svg"');
    expect(anchor).toContain('>Acme Engineering Docs<');
    expect(anchor).not.toContain('spr-brand-mark');
  });

  it('leaves the picture decorative when the name is beside it', () => {
    expect(withLogo(true)).toContain('alt=""');
  });

  it('gives the picture the name when the name is not written out', () => {
    const anchor = withLogo(false);
    expect(anchor).toContain('alt="Acme Engineering Docs"');
    expect(anchor).not.toContain('>Acme Engineering Docs<');
  });

  it('never lets the switch take the name away when there is nothing to take it for', () => {
    const anchor = brandAnchor(
      renderPage('<h1>A page</h1>', {
        title: 'A page',
        nonce: 'test-nonce',
        ...pageChrome(request('/handbook/introduction', undefined), {
          ...CHROME,
          brandShowName: false,
        }),
      }),
    );
    expect(anchor).toContain('>Acme Engineering Docs<');
  });

  it('sends both logos when there are two, for the sheet to choose between', () => {
    const anchor = brandAnchor(
      renderPage('<h1>A page</h1>', {
        title: 'A page',
        nonce: 'test-nonce',
        ...pageChrome(request('/handbook/introduction', undefined), {
          ...CHROME,
          brandLogoUrl: '/-/brand/abc123.svg',
          brandLogoDarkUrl: '/-/brand/def456.svg',
        }),
      }),
    );

    expect(anchor).toContain('class="spr-brand-logo spr-brand-logo-light"');
    expect(anchor).toContain('src="/-/brand/abc123.svg"');
    expect(anchor).toContain('class="spr-brand-logo spr-brand-logo-dark"');
    expect(anchor).toContain('src="/-/brand/def456.svg"');
    expect((anchor.match(/<img/g) ?? []).length).toBe(2);
  });

  it('marks neither when there is one, so nothing can hide the only logo there is', () => {
    const anchor = withLogo(true);
    expect(anchor).toContain('class="spr-brand-logo"');
    expect(anchor).not.toContain('spr-brand-logo-light');
    expect(anchor).not.toContain('spr-brand-logo-dark');
    expect((anchor.match(/<img/g) ?? []).length).toBe(1);
  });

  it('gives both pictures the same alt, since only the drawn one is announced', () => {
    const anchor = brandAnchor(
      renderPage('<h1>A page</h1>', {
        title: 'A page',
        nonce: 'test-nonce',
        ...pageChrome(request('/handbook/introduction', undefined), {
          ...CHROME,
          brandLogoUrl: '/-/brand/abc123.svg',
          brandLogoDarkUrl: '/-/brand/def456.svg',
          brandShowName: false,
        }),
      }),
    );
    expect((anchor.match(/alt="Acme Engineering Docs"/g) ?? []).length).toBe(2);
  });

  it('never points the logo at another host', () => {
    const html = renderPage('<h1>A page</h1>', {
      title: 'A page',
      nonce: 'test-nonce',
      ...pageChrome(request('/handbook/introduction', undefined), {
        ...CHROME,
        brandLogoUrl: '/-/brand/abc123.svg',
      }),
    });
    expect(/<img[^>]+src="(?!\/-\/brand\/)/.test(html)).toBe(false);
  });

  it('is escaped, like every other configured string in the shell', () => {
    const html = renderPage('<h1>A page</h1>', {
      title: 'A page',
      nonce: 'test-nonce',
      ...pageChrome(request('/handbook/introduction', undefined), {
        ...CHROME,
        brand: '<img src=x onerror=alert(1)>',
      }),
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('is in the shell, above `<main>`', () => {
    const html = header('/handbook/introduction', undefined);
    expect(html.indexOf('spr-brand')).toBeLessThan(html.indexOf('<main'));
  });
});

describe('the search box in the header', () => {
  const html = header('/handbook/introduction', undefined);

  it('carries its mark inside the box, in the shape every such box uses', () => {
    const box = /<form class="spr-search"[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
    expect(box).toContain('<span class="spr-input-icon">');
    expect(box.indexOf('<svg')).toBeGreaterThan(-1);
    expect(box.indexOf('<svg')).toBeLessThan(box.indexOf('<input'));
  });

  it('draws it inline rather than through the per-page sprite', () => {
    const mark = /<svg class="spr-icon"[\s\S]*?<\/svg>/.exec(searchIcon())?.[0] ?? '';
    expect(mark).not.toBe('');
    expect(searchIcon()).not.toContain('<use');
    expect(searchIcon()).toContain('stroke="currentColor"');
    expect(searchIcon()).toContain('aria-hidden="true"');
    expect(html).toContain('aria-label="Search"');
  });
});

describe('the sign-in flow itself', () => {
  it('does not offer to start itself', () => {
    const chrome = pageChrome(request('/api/auth/login', undefined), CHROME, {
      offerSignIn: false,
    });
    expect(chrome.signInHref).toBeNull();
    const html = renderPage('<h1>Sign in</h1>', { title: 'Sign in', nonce: 'n', ...chrome });
    expect(html).not.toContain('class="spr-signin"');
  });

  it('still shows a signed-in reader their account', () => {
    const chrome = pageChrome(request('/api/auth/login', caller()), CHROME, {
      offerSignIn: false,
    });
    const html = renderPage('<h1>Sign in</h1>', { title: 'Sign in', nonce: 'n', ...chrome });
    expect(html).toContain('spr-avatar');
  });
});

describe('the icon in the browser tab', () => {
  const head = (over: Partial<typeof CHROME>): string => {
    const html = renderPage('<h1>A page</h1>', {
      title: 'A page',
      nonce: 'test-nonce',
      ...pageChrome(request('/handbook/introduction', undefined), { ...CHROME, ...over }),
    });
    return html.slice(0, html.indexOf('</head>'));
  };

  it('is named on every page, so a browser needs no request to find it', () => {
    expect(head({})).toMatch(/<link rel="icon" href="\/favicon\.ico" type="image\/svg\+xml"/);
  });

  it('is the configured one under the name of its bytes, where there is one', () => {
    expect(head({ faviconUrl: '/-/brand/abc123.png', faviconType: 'image/png' })).toMatch(
      /<link rel="icon" href="\/-\/brand\/abc123\.png" type="image\/png"/,
    );
  });

  it('is never fetched from another host, as nothing on this page is', () => {
    const links = [...head({}).matchAll(/<link[^>]+href="([^"]+)"/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThan(0);
    expect(links.filter((href) => !href.startsWith('/'))).toEqual([]);
  });
});
