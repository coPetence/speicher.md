import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadDocument } from '../../src/dashboard/configurator/config-form/document';
import {
  CONFIG_SECTIONS,
  buildSections,
} from '../../src/dashboard/configurator/config-form/fields';
import {
  EMPTY_ART,
  SECTION_EMPTY_ART,
  emptyStateArt,
  sectionEmptyArt,
  tableEmptyArt,
} from '../../src/content-reader/empty-state';
import { renderTemplate } from '../../src/content-reader/views';

const SHEET = readFileSync(
  join(__dirname, '../../src/global-ui/theme/default.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

describe.each(EMPTY_ART)('the %s empty state drawing', (kind) => {
  const ART = emptyStateArt(kind);

  it('carries no colour of its own', () => {
    expect(ART).toContain('stroke="currentColor"');
    const paints = [...ART.matchAll(/\b(?:fill|stroke)="([^"]*)"/g)].map((m) => m[1]);
    expect(paints.length).toBeGreaterThan(2);
    expect(paints.filter((paint) => paint !== 'currentColor' && paint !== 'none')).toEqual([]);
  });

  it('puts its geometry in attributes, which is all the CSP lets through', () => {
    expect(ART).not.toMatch(/\sstyle=/);
    expect(ART).not.toContain('<style');
  });

  it('defines no name, so a page may draw it twice', () => {
    expect(ART).not.toMatch(/\sid=/);
    expect(ART).not.toContain('url(');
  });

  it('reaches for nothing outside the page', () => {
    expect(ART).not.toMatch(/href=/);
    expect(ART).not.toContain('<image');
    expect(ART).not.toContain('<script');
  });

  it('is decoration, and says so', () => {
    expect(ART).toMatch(/^<svg [^>]*aria-hidden="true"/);
  });

  it('is sized by the sheet, since the markup carries no dimensions', () => {
    const root = /^<svg [^>]*>/.exec(ART)?.[0] ?? '';
    expect(root).toContain('viewBox=');
    expect(root).not.toMatch(/\s(?:width|height)=/);

    const rule = /\.spr-empty-art\s*\{([^}]*)\}/.exec(SHEET)?.[1] ?? '';
    expect(rule).toMatch(/\bwidth\s*:/);
    expect(rule).toMatch(/\bheight\s*:/);
  });

  it('is grey through the token the sentence under it uses', () => {
    const art = /\.spr-empty-art\s*\{([^}]*)\}/.exec(SHEET)?.[1] ?? '';
    const prose = /\.spr-empty\s*\{([^}]*)\}/.exec(SHEET)?.[1] ?? '';
    expect(art).toMatch(/\bcolor\s*:\s*var\(--spr-muted\)/);
    expect(prose).toMatch(/\bcolor\s*:\s*var\(--spr-muted\)/);
  });
});

describe('the set of drawings', () => {
  it('draws the sheet when nothing is asked for', () => {
    expect(emptyStateArt()).toBe(emptyStateArt('page'));
  });

  it('gives each kind a drawing of its own', () => {
    const drawn = EMPTY_ART.map((kind) => emptyStateArt(kind));
    expect(EMPTY_ART.length).toBeGreaterThan(3);
    expect(new Set(drawn).size).toBe(EMPTY_ART.length);
  });

  it('closes every dotted outline on a whole number of dots', () => {
    for (const kind of EMPTY_ART) {
      const circles = [
        ...emptyStateArt(kind).matchAll(/<circle [^>]*stroke-dasharray="1 6"[^>]*>/g),
      ];
      for (const [circle] of circles) {
        const length = Number(/pathLength="(\d+)"/.exec(circle)?.[1]);
        expect(length % 7).toBe(0);
      }
    }
  });
});

describe('the drawing a configuration index has', () => {
  it('names only sections that exist', () => {
    const ids = CONFIG_SECTIONS.map((section) => section.id);
    expect(SECTION_EMPTY_ART.length).toBeGreaterThan(0);
    expect(SECTION_EMPTY_ART.filter((id) => !ids.includes(id))).toEqual([]);
  });

  it('names only member indexes, which are the pages that can be empty', () => {
    const sections = buildSections(loadDocument('version: 1\n'));
    for (const id of SECTION_EMPTY_ART) {
      expect(['table', 'tiles']).toContain(sections.find((section) => section.id === id)?.layout);
    }
  });

  it('answers with that section\u2019s drawing, and with nothing for any other', () => {
    for (const id of SECTION_EMPTY_ART) expect(sectionEmptyArt(id)).toBe(emptyStateArt(id));
    expect(sectionEmptyArt('mail')).toBe('');
    expect(sectionEmptyArt('sources/gh')).toBe('');
  });

  it('draws a group with no members as the groups index draws no groups', () => {
    expect(tableEmptyArt('groups/engineering')).toBe(emptyStateArt('groups'));
    expect(tableEmptyArt('groups')).toBe('');
    expect(tableEmptyArt('sources/gh')).toBe('');
  });

  it('can be taken off the page, which its own layout would otherwise prevent', () => {
    expect(SHEET).toMatch(/\.spr-empty-state\[hidden\]\s*\{[^}]*display\s*:\s*none/);
  });
});

describe('the drawing on the 404', () => {
  const page = (authenticated: boolean) =>
    renderTemplate('global-ui/global-views/not-found', {
      authenticated,
      art: emptyStateArt('missing'),
    });

  it('is drawn, over the heading and the sentence', () => {
    const html = page(true);
    expect(html).toContain(emptyStateArt('missing'));
    expect(html.indexOf('spr-empty-art')).toBeLessThan(html.indexOf('<h1>'));
    expect(html.indexOf('<h1>')).toBeLessThan(html.indexOf('There is nothing at this address'));
  });

  it('is drawn larger than under a table, and by the sheet', () => {
    expect(page(true)).toMatch(/<div class="spr-empty-state spr-empty-state-page">/);
    const factor = (selector: string) =>
      Number(
        new RegExp(
          `${selector}\\s*\\{[^}]*\\bwidth\\s*:\\s*calc\\(var\\(--spr-space-8\\) \\* (\\d+)\\)`,
        ).exec(SHEET)?.[1],
      );
    expect(factor('\\.spr-empty-state-page \\.spr-empty-art')).toBeGreaterThan(
      factor('\\n  \\.spr-empty-art'),
    );
  });

  it('is asked nothing about the request, so it cannot answer differently', () => {
    const strip = (html: string) => html.replace(/<p class="spr-empty">[\s\S]*?<\/p>/, '');
    expect(strip(page(true))).toBe(strip(page(false)));
  });

  it('shows something absent, never something withheld', () => {
    expect(emptyStateArt('missing')).not.toBe(emptyStateArt('admins'));
    expect(emptyStateArt('missing')).toMatch(/<path d="M46 20[^"]*z" stroke-dasharray/);
  });
});

describe('the drawing on the error page', () => {
  const page = (requestId: string | null) =>
    renderTemplate('global-ui/global-views/server-error', {
      requestId,
      art: emptyStateArt('broken'),
    });

  it('is drawn, over the heading and the sentence, at the 404\u2019s size', () => {
    const html = page('req-1');
    expect(html).toContain(emptyStateArt('broken'));
    expect(html).toMatch(/<div class="spr-empty-state spr-empty-state-page">/);
    expect(html.indexOf('spr-empty-art')).toBeLessThan(html.indexOf('<h1>'));
    expect(html.indexOf('<h1>')).toBeLessThan(html.indexOf('<p class="spr-empty">'));
  });

  it('is not the 404\u2019s drawing', () => {
    expect(emptyStateArt('broken')).not.toBe(emptyStateArt('missing'));
  });

  it('still carries the request id, and only that', () => {
    expect(page('req-1')).toContain('<code>req-1</code>');
    expect(page(null)).not.toContain('Request ID');
  });
});

describe('the drawing on a search with no results', () => {
  const page = (results: unknown[]) =>
    renderTemplate('content-reader/views/search', {
      query: 'q',
      count: results.length,
      results,
      art: emptyStateArt('unmatched'),
    });

  it('is drawn only when nothing matched, with the count under it', () => {
    const empty = page([]);
    expect(empty).toContain(emptyStateArt('unmatched'));
    expect(empty).not.toContain('spr-crumbs');
    expect(empty).toMatch(/spr-empty-art[\s\S]*0 results for &ldquo;q&rdquo;/);
    expect(page([])).toMatch(/<div class="spr-empty-state spr-empty-state-page">/);
    expect(page([{ title: 't', href: '/t', repo: 'a/b', snippet: 's' }])).not.toContain(
      'spr-empty-art',
    );
  });

  it('is its own drawing, not the 404\u2019s', () => {
    expect(emptyStateArt('unmatched')).not.toBe(emptyStateArt('missing'));
  });
});
