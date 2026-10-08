import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { stylesheetUrl, templateNames } from '../../src/content-reader/assets.controller';

import { closeSequelize } from '../../src/db/sequelize';
import { Harness, PrincipalName, createHarness } from '../helpers/harness';
import { bootTestApp, sessionCookieFor } from '../helpers/http';

let app: INestApplication;
let harness: Harness;
const cookies: Partial<Record<PrincipalName, string>> = {};

beforeAll(async () => {
  harness = await createHarness();
  app = await bootTestApp();
  for (const name of ['alice', 'bob', 'carol'] as PrincipalName[]) {
    cookies[name] = await sessionCookieFor(harness.tenantId, name);
  }
});

afterAll(async () => {
  await app?.close();
  await harness?.close();
  await closeSequelize();
});

const page = (who: PrincipalName | 'anonymous', path: string) => {
  const req = request(app.getHttpServer()).get(path);
  return who === 'anonymous' ? req : req.set('Cookie', cookies[who] as string);
};

const fragment = (who: PrincipalName | 'anonymous', path: string) =>
  page(who, path).set('X-Speicher-Fragment', '1');

const navOf = (html: string) => (html.match(/<nav class="spr-nav"[\s\S]*?<\/nav>/) ?? [''])[0];

describe('the tree is server-rendered in the right state', () => {
  it('opens the ancestors of the current page and nothing else', async () => {
    const res = await page('alice', '/fieldkit/python-sdk/async/async-device');
    const nav = navOf(res.text);
    expect(nav).toContain('data-tree-toggle="python-sdk"');
    expect(nav).toMatch(
      /aria-expanded="true"[^>]*aria-controls="tree-python-sdk"|aria-controls="tree-python-sdk"[^>]*aria-expanded="true"/,
    );
    expect(nav).toContain('hidden');
    expect((nav.match(/aria-expanded="false"/g) ?? []).length).toBeGreaterThan(2);
  });

  it('marks the current page, exactly once', async () => {
    const nav = navOf((await page('alice', '/fieldkit/device-management')).text);
    expect((nav.match(/aria-current="page"/g) ?? []).length).toBe(1);
  });

  it('gives every folder a labelled disclosure button separate from its link', async () => {
    const nav = navOf((await page('alice', '/fieldkit/device-management')).text);
    expect(nav).toMatch(
      /<button type="button" class="spr-nav-toggle"[^>]*aria-label="(Expand|Collapse) [^"]+"/,
    );
    expect(nav).toMatch(/<a href="\/fieldkit\/python-sdk"[^>]*data-tree-link>/);
  });

  it('hides the children of a closed folder from the accessibility tree too', async () => {
    const nav = navOf((await page('alice', '/fieldkit/device-management')).text);
    expect(nav).toMatch(/data-tree-group="[^"]+" hidden/);
  });

  it('still names no folder the caller cannot see', async () => {
    const nav = navOf((await page('alice', '/handbook/introduction')).text);
    expect(nav).not.toMatch(/commercial/i);
    expect(nav).not.toMatch(/northwind/i);
  });

  it('tells the island which folders have an index page behind their label', async () => {
    const nav = navOf((await page('alice', '/fieldkit/python-sdk/async/async-device')).text);
    expect(nav).toMatch(/<a href="\/fieldkit\/python-sdk"[^>]*data-tree-index/);
    expect(nav).not.toMatch(/<a href="\/fieldkit\/python-sdk\/async"[^>]*data-tree-index/);
  });

  it('merges a folder and its landing page into one row', async () => {
    const nav = navOf((await page('alice', '/handbook/reference/client')).text);
    expect((nav.match(/href="\/handbook\/reference"/g) ?? []).length).toBe(1);
    expect(nav).toContain('data-tree-toggle="reference"');
  });
});

describe('the fragment route', () => {
  it('returns the content, the title and the icons it needs', async () => {
    const res = await fragment('alice', '/fieldkit/device-management');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(Object.keys(res.body).sort()).toEqual(['countable', 'html', 'symbols', 'title', 'tree']);
    expect(res.body.title).toBe('Device Management');
    expect(res.body.html).toMatch(/<h1[^>]*>/);
  });

  it('omits the nav tree, which is the whole point', async () => {
    const res = await fragment('alice', '/fieldkit/device-management');
    expect(res.body.html).not.toContain('data-tree-toggle');
  });

  it('carries no nonce-bearing markup', async () => {
    const res = await fragment('alice', '/fieldkit/device-management');
    expect(res.body.html).not.toContain('nonce');
    expect(res.body.symbols).not.toContain('nonce');
  });

  it('transfers far less than the full page', async () => {
    const full = await page('alice', '/fieldkit/regions');
    const frag = await fragment('alice', '/fieldkit/regions');
    expect(JSON.stringify(frag.body).length).toBeLessThan(full.text.length / 3);
  });

  it('varies on the fragment header, so no cache can confuse the two', async () => {
    const res = await fragment('alice', '/fieldkit/device-management');
    expect(String(res.headers['vary']).toLowerCase()).toContain('x-speicher-fragment');
  });

  it('serves a folder listing as a fragment too', async () => {
    const res = await fragment('carol', '/handbook/northwind');
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Northwind Engineering');
  });

  // The island swaps only when these agree, so they must be one string: a page and
  // a listing of one repository, and the shell either of them was loaded in. Two
  // repositories so the assertion cannot pass by every answer being the same.
  it('names the repository whose tree it belongs beside, as the shell does', async () => {
    const shellOf = async (path: string) =>
      /class="spr-layout"[^>]*data-spr-tree="([^"]*)"/.exec((await page('alice', path)).text)?.[1];

    expect((await fragment('alice', '/fieldkit/device-management')).body.tree).toBe('/fieldkit');
    expect(await shellOf('/fieldkit/device-management')).toBe('/fieldkit');
    expect((await fragment('carol', '/handbook/northwind')).body.tree).toBe('/handbook');
    expect(await shellOf('/handbook/reference/client')).toBe('/handbook');
  });
});

describe('the fragment route enforces the same filter as the page route', () => {
  const PATHS = [
    '/handbook/introduction',
    '/handbook/commercial',
    '/handbook/commercial/pricing',
    '/handbook/commercial/legal',
    '/handbook/northwind/handover',
    '/fieldkit/device-management',
    '/northwind-engineering/specs/tolerances',
  ];

  for (const who of ['alice', 'bob', 'carol', 'anonymous'] as const) {
    it(`agrees with the page route for ${who}`, async () => {
      for (const path of PATHS) {
        const full = await page(who, path);
        const frag = await fragment(who, path);
        expect([path, frag.status]).toEqual([path, full.status]);
      }
    });
  }

  it('never returns content in a refusal', async () => {
    const res = await fragment('alice', '/handbook/commercial/pricing');
    expect(res.status).toBe(404);
    expect(res.text).not.toMatch(/Rate card|1,850/);
  });

  it('404s a restricted path exactly as a nonexistent one', async () => {
    const restricted = await fragment('alice', '/handbook/commercial/pricing');
    const absent = await fragment('alice', '/handbook/no-such-page');
    expect(restricted.status).toBe(absent.status);
    expect(restricted.headers['content-type']).toBe(absent.headers['content-type']);
  });
});

describe('theme templates', () => {
  it('serves the selected template, content-hashed and immutable', async () => {
    const html = (await page('alice', '/handbook/introduction')).text;
    const href = /<link rel="stylesheet" href="(\/-\/static\/theme-[^"]+)"/.exec(html)?.[1];
    expect(href).toBeDefined();

    const css = await request(app.getHttpServer()).get(href as string);
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect(css.headers['cache-control']).toContain('immutable');
  });

  it('carries the layer order, so a template never needs a specificity hack', async () => {
    const html = (await page('alice', '/handbook/introduction')).text;
    const href = /href="(\/-\/static\/theme-[^"]+)"/.exec(html)![1];
    const css = (await request(app.getHttpServer()).get(href)).text;
    expect(css).toMatch(/@layer\s+speicher\.base\s*,\s*speicher\.theme\s*,\s*speicher\.custom/);
  });

  it('inlines no stylesheet into the page', async () => {
    const html = (await page('alice', '/handbook/introduction')).text;
    expect(html).not.toContain('<style');
  });

  it('allows the external sheet without allowing inline styles', async () => {
    const csp = String(
      (await page('alice', '/handbook/introduction')).headers['content-security-policy'],
    );
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
  });

  it('bundles each template self-contained, so a page is one stylesheet request', async () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '../../dist/client/manifest.json'), 'utf8'),
    ) as Record<string, string>;
    const templates = Object.keys(manifest).filter((k) => k.startsWith('theme-'));
    expect(templates.length).toBeGreaterThan(1);

    for (const key of templates) {
      const css = readFileSync(join(__dirname, '../../dist/client', manifest[key]), 'utf8');
      expect(css).toContain('speicher.base');
      expect(css).toContain('--spr-fg');
    }
  });

  it('falls back to the default for an unknown template, rather than shipping no styles', async () => {
    expect(stylesheetUrl('no-such-template')).toBe(stylesheetUrl('default'));
    expect(stylesheetUrl('no-such-template')).not.toBeNull();
  });

  it('knows which templates were built', () => {
    expect(templateNames()).toEqual(expect.arrayContaining(['default', 'editorial']));
  });
});

describe('the breadcrumb trail', () => {
  it('is absent on a top-level page, where it would be one link', async () => {
    const article = (await page('alice', '/handbook/introduction')).text;
    expect(article).not.toContain('class="spr-crumbs"');
  });

  it('is absent on a top-level listing, for the same reason', async () => {
    const listing = (await page('alice', '/handbook/reference')).text;
    expect(listing).not.toContain('class="spr-crumbs"');
  });

  it('is drawn once a page sits inside a folder, and every step is a link', async () => {
    const article = (await page('alice', '/handbook/reference/errors')).text;
    const crumbs = (article.match(/<div class="spr-crumbs">[\s\S]*?<\/div>/) ?? [''])[0];
    expect(crumbs).toContain('href="/handbook/"');
    expect(crumbs).toContain('href="/handbook/reference"');
    expect((crumbs.match(/<a /g) ?? []).length).toBe(2);
  });
});

describe('the page title', () => {
  const headingOf = (html: string) => (html.match(/<h1[^>]*>[\s\S]*?<\/h1>/) ?? [''])[0];

  it('is the frontmatter title, not the heading the body happened to carry', async () => {
    const article = (await page('alice', '/handbook/setup')).text;
    expect(headingOf(article)).toContain('Setting up');
    expect(article).not.toMatch(/<h1[^>]*>(?:(?!<\/h1>)[\s\S])*Setup<\/h1>/);
    expect((article.match(/<h1/g) ?? []).length).toBe(1);
  });

  it('is drawn for a page whose body never had a heading', async () => {
    const article = (await page('alice', '/fieldkit/')).text;
    const heading = headingOf(article);
    expect(heading).not.toBe('');
    expect(heading).not.toContain('<h1></h1>');
  });

  it('carries the mark the tree draws the same page with', async () => {
    const article = (await page('alice', '/handbook/setup')).text;
    expect(headingOf(article)).toContain('<use href="#i-wrench"/>');
    expect(article).toContain('<symbol id="i-wrench"');
  });

  it('comes before the body, and the body has not been swallowed', async () => {
    const article = (await page('alice', '/handbook/setup')).text;
    const main = article.slice(article.indexOf('<div class="spr-article">'));
    expect(main.indexOf('<h1')).toBeLessThan(main.indexOf('<h2'));
    expect(main).toContain('<h2');
  });

  it('answers the anchor the removed heading answered', async () => {
    const article = (await page('alice', '/handbook/reference')).text;
    expect(headingOf(article)).toContain('id="reference"');
  });

  it('is the folder\u2019s own name on a landing page, above its children', async () => {
    const landing = (await page('alice', '/handbook/reference')).text;
    expect(headingOf(landing)).toContain('Reference');
    expect(landing.indexOf('<h1')).toBeLessThan(landing.indexOf('<h2>In this section</h2>'));
    const crumbs = (landing.match(/<div class="spr-crumbs">[\s\S]*?<\/div>/) ?? [''])[0];
    expect(crumbs).not.toContain('>Reference<');
  });

  it('travels with a fragment navigation', async () => {
    const res = await fragment('alice', '/handbook/setup');
    expect(headingOf(res.body.html)).toContain('Setting up');
  });
});

describe('the default icon', () => {
  it('marks a tree entry and a card that named no icon, by kind', async () => {
    const res = (await page('alice', '/fieldkit/')).text;
    const nav = navOf(res);
    expect(nav).toContain('<use href="#i-file-text"/>');
    expect(nav).toContain('<use href="#i-folder"/>');
    // Anchored on the heading, because an MDX `<CardGrid>` is deliberately the
    // same markup (rule 45) and fieldkit's landing page opens with one — so the
    // first grid on the page is the author's, not the folder's.
    const cards =
      res.match(
        /<h2>In this section<\/h2>\s*<ul class="spr-listing spr-cards">[\s\S]*?<\/ul>/,
      )?.[0] ?? '';
    expect(cards).toContain('<use href="#i-file-text"/>');
    expect(cards).toContain('<use href="#i-folder"/>');
    expect(res).toContain('<symbol id="i-file-text"');
    expect(res).toContain('<symbol id="i-folder"');
  });

  it('gives way to the icon an author named', async () => {
    const nav = navOf((await page('alice', '/handbook/introduction')).text);
    expect(nav).toContain('<use href="#i-sparkles"/>');
    expect(nav).not.toMatch(/<use href="#i-sparkles"\/><\/svg><use/);
  });
});

describe('a folder\u2019s children', () => {
  it('are cards under a page that has them', async () => {
    const article = (await page('alice', '/handbook/reference')).text;
    expect(article).toContain('<h2>In this section</h2>');
    expect(article).toContain('<ul class="spr-listing spr-cards">');
  });

  it('carry no kind label, since every card has an icon that says it', async () => {
    const cards =
      (await page('alice', '/handbook/')).text.match(
        /<ul class="spr-listing spr-cards">[\s\S]*?<\/ul>/,
      )?.[0] ?? '';
    expect(cards).toContain('<use href="#i-');
    expect(cards).not.toContain('spr-kind');
  });

  it('are cards on a generated listing too', async () => {
    const listing = (await page('alice', '/speicher-docs/internal')).text;
    expect(listing).toContain('<ul class="spr-listing spr-cards">');
  });

  it('leave search results in one column, which is the one listing that is ranked', async () => {
    const results = (await page('alice', '/?q=setup')).text;
    expect(results).toContain('spr-cards-rows');
  });
});

describe('a page with no tree', () => {
  it('gives the article the whole shell', async () => {
    const missing = await page('alice', '/handbook/no-such-page');
    expect(missing.status).toBe(404);
    expect(missing.text).toContain('<div class="spr-layout">');

    const article = (await page('alice', '/handbook/introduction')).text;
    expect(article).toContain(
      '<div class="spr-layout" data-tree data-spr-tree="/handbook" data-article data-docked>',
    );
  });

  // The attribute reserves the related column's track; a page with no aside
  // carries it too, so the article does not move between two neighbours.
  it('lays out every reader page as an article, aside or not', async () => {
    for (const where of [
      '/',
      '/handbook',
      '/handbook/introduction',
      '/?q=setup',
      '/?tag=onboarding',
    ]) {
      const res = await page('alice', where);
      expect([200, 404]).toContain(res.status);
      if (res.status === 200)
        expect(res.text).toMatch(/<div class="spr-layout"[^>]* data-article[ >]/);
    }
  });

  // Only a document and a folder carry the toolbar inside the card. They are also
  // the only two views that answer a fragment, so a swap never crosses from one
  // shell to the other; every other page keeps the toolbar in the header.
  it('docks the toolbar into the card on reading pages, and nowhere else', async () => {
    const shell = (text: string) => /<div class="spr-layout"[^>]*>/.exec(text)?.[0] ?? '';
    for (const where of ['/handbook', '/handbook/introduction']) {
      const text = (await page('alice', where)).text;
      expect(shell(text)).toContain('data-docked');
      expect(text).toMatch(/<div class="spr-pane">\s*<div class="spr-toolbar">/);
    }
    for (const where of ['/', '/?q=setup', '/?tag=onboarding', '/handbook/no-such-page']) {
      const text = (await page('alice', where)).text;
      expect(shell(text)).not.toContain('data-docked');
      expect(/<header class="spr-header">[\s\S]*?<\/header>/.exec(text)?.[0]).toContain(
        'class="spr-toolbar"',
      );
    }
  });
});

describe('the width the reader dragged the tree to', () => {
  const withWidth = (value: string) =>
    request(app.getHttpServer())
      .get('/handbook/introduction')
      .set('Cookie', [cookies.alice as string, `speicher_nav_width=${value}`].join('; '));

  it('arrives with the document', async () => {
    const html = (await withWidth('284')).text;
    expect(html).toMatch(/<style nonce="[^"]+">:root\{--spr-nav-user:284px\}<\/style>/);
  });

  it('is a number by the time it reaches the page, whatever arrived', async () => {
    const html = (await withWidth(encodeURIComponent('284px;background:url(https://evil.test)')))
      .text;
    expect(html).not.toContain('evil.test');
    expect(html).not.toContain('<style');
  });
});

describe('the island bundle', () => {
  it('is referenced with a nonce, so it runs under a CSP with no unsafe-inline', async () => {
    const res = await page('alice', '/handbook/introduction');
    const csp = String(res.headers['content-security-policy']);
    const script = /<script type="module" nonce="([^"]+)" src="(\/-\/static\/[^"]+)"/.exec(
      res.text,
    );
    expect(script).not.toBeNull();
    expect(csp).toContain(`'nonce-${script![1]}'`);
    expect(csp).not.toContain('unsafe-inline');
  });

  it('is served immutably, because its name carries a content hash', async () => {
    const html = (await page('alice', '/handbook/introduction')).text;
    const url = /src="(\/-\/static\/[^"]+)"/.exec(html)![1];
    const res = await request(app.getHttpServer()).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['content-type']).toContain('text/javascript');
  });

  it('is public, since it carries behaviour and never content', async () => {
    const html = (await page('alice', '/handbook/introduction')).text;
    const url = /src="(\/-\/static\/[^"]+)"/.exec(html)![1];
    expect((await request(app.getHttpServer()).get(url)).status).toBe(200);
  });

  it('serves only files the build produced', async () => {
    for (const path of [
      '/-/static/nope.js',
      '/-/static/..%2f..%2fmain.js',
      '/-/static/manifest.json',
    ]) {
      expect((await request(app.getHttpServer()).get(path)).status).toBe(404);
    }
  });
});
