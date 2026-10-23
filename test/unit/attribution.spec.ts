import type { Request } from 'express';

import { renderDashboardPage } from '../../src/dashboard/respond';
import { pageChrome } from '../../src/content-reader/chrome';
import { renderPage } from '../../src/global-ui/global-views/page-layout/page-layout';

function shell(attribution: boolean): string {
  const req = { path: '/handbook/introduction', cookies: {} } as unknown as Request;
  return renderPage('<h1>A page</h1>', {
    title: 'A page',
    nonce: 'test-nonce',
    ...pageChrome(req, {
      themeTemplate: 'default',
      themeTui: false,
      themeOverridesFor: () => null,
      brand: 'Acme Engineering Docs',
      brandLogoUrl: null,
      brandLogoDarkUrl: null,
      brandWallpaperUrl: null,
      brandWallpaperDarkUrl: null,
      brandWallpaperAllThemes: false,
      faviconUrl: '/favicon.ico',
      faviconType: 'image/svg+xml',
      brandShowName: true,
      brandNameAlign: 'center',
      hasContentSource: true,
      attribution,
    }),
  });
}

describe('the attribution', () => {
  const on = shell(true);

  it('names the product, and links to it', () => {
    expect(on).toContain('class="spr-attribution"');
    expect(on).toContain('Published with');
    expect(on).toContain('href="https://speicher.md"');
  });

  it('is gone entirely when the instance switches it off', () => {
    const off = shell(false);
    expect(off).not.toContain('spr-attribution');
    expect(off).not.toContain('speicher.md');
    expect(off).not.toContain('Published with');
  });

  it('never appears on the operational pages, whatever the instance says', () => {
    const req = { path: '/-/config', cookies: {} } as unknown as Request;
    const page = renderDashboardPage(
      req,
      {
        themeTemplate: 'default',
        themeTui: false,
        themeOverridesFor: () => null,
        brand: 'Acme Engineering Docs',
        brandLogoUrl: null,
        brandLogoDarkUrl: null,
        brandWallpaperUrl: null,
        brandWallpaperDarkUrl: null,
        brandWallpaperAllThemes: false,
        faviconUrl: '/favicon.ico',
        faviconType: 'image/svg+xml',
        brandShowName: true,
        brandNameAlign: 'center',
        hasContentSource: true,
        attribution: true,
      },
      {
        section: 'config',
        title: 'Configuration',
        body: '<h1>Configuration</h1>',
        isAdmin: true,
        nonce: 'n',
      },
    );
    expect(page).not.toContain('spr-attribution');
    expect(page).not.toContain('speicher.md');
  });

  it('is in the shell, below `<main>`', () => {
    expect(on.indexOf('</main>')).toBeLessThan(on.indexOf('spr-attribution'));
    expect(on.indexOf('spr-attribution')).toBeLessThan(on.indexOf('</body>'));
  });

  it('issues no third-party request of any kind', () => {
    const footer = /<footer class="spr-attribution">([\s\S]*?)<\/footer>/.exec(on)?.[1] ?? '';
    expect(footer).not.toBe('');
    expect(footer).not.toMatch(/<img|src=|url\(|background/i);
  });

  it('tells the destination nothing about the page it was on', () => {
    expect(on).toMatch(/href="https:\/\/speicher\.md"[^>]*rel="noopener noreferrer nofollow"/);
  });

  it('opens in a new tab, so it never takes a reader out of the docs', () => {
    expect(on).toMatch(/href="https:\/\/speicher\.md"[^>]*target="_blank"/);
  });
});
