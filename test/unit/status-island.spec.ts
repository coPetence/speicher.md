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
  return readFileSync(join(dir, manifest.status), 'utf8');
})();

function render(query = ''): void {
  document.body.innerHTML = `
    <main>
      <div class="spr-index-bar">
        <form class="spr-form spr-filter" method="get" action="/-/status" data-spr-filter>
          <input id="filter-status" type="search" name="q" value="${query}" aria-label="Find a repository">
          <button type="submit" class="spr-filter-go">Filter</button>
        </form>
        <form method="post" action="/-/discover" class="spr-form spr-index-op">
          <button type="submit">Discover now</button>
        </form>
      </div>
      <div class="spr-scroll">
        <table class="spr-table" data-spr-rows>
          <tbody>
            <tr data-spr-row="copetence handbook gh github"><th><a href="#">copetence/handbook</a></th></tr>
            <tr data-spr-row="northwind-engineering specs gh github"><th><a href="#">northwind-engineering/specs</a></th></tr>
          </tbody>
        </table>
      </div>
      <div class="spr-empty-state" data-spr-empty="none" hidden>
        <p class="spr-empty">No repositories are configured.</p>
      </div>
      <div class="spr-empty-state" data-spr-empty="filtered" hidden>
        <p class="spr-empty">No repository matches <code data-spr-needle>${query}</code>.</p>
      </div>
    </main>`;
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('tr[data-spr-row]'));
const shown = () =>
  rows()
    .filter((row) => !row.hidden)
    .map((row) => row.dataset.sprRow?.split(' ')[1]);
const box = () => document.querySelector('input[name="q"]') as HTMLInputElement;
const scroll = () => document.querySelector('.spr-scroll') as HTMLElement;
const emptyNone = () => document.querySelector('[data-spr-empty="none"]') as HTMLElement;
const emptyFiltered = () => document.querySelector('[data-spr-empty="filtered"]') as HTMLElement;

function run(): void {
  // eslint-disable-next-line no-new-func
  new Function(BUNDLE)();
}

function filter(value: string): void {
  box().value = value;
  box().dispatchEvent(new Event('input', { bubbles: true }));
}

describe('the status page filter', () => {
  it('finds this page’s table, which is not the configurator’s', () => {
    render();
    run();
    expect(document.querySelector('.spr-filter')?.hasAttribute('data-spr-live')).toBe(true);

    filter('handbook');
    expect(shown()).toEqual(['handbook']);
  });

  it('narrows on the source as well as the name, because the row shows both', () => {
    render();
    run();
    filter('gh');
    expect(shown()).toEqual(['handbook', 'specs']);

    filter('northwind');
    expect(shown()).toEqual(['specs']);

    filter('');
    expect(shown()).toEqual(['handbook', 'specs']);
  });

  it('puts the table aside for the sentence the server wrote', () => {
    render();
    run();
    filter('nothing-matches-this');

    expect(shown()).toEqual([]);
    expect(scroll().hidden).toBe(true);
    expect(emptyFiltered().hidden).toBe(false);
    expect(emptyNone().hidden).toBe(true);
    expect(emptyFiltered().querySelector('[data-spr-needle]')?.textContent).toBe(
      'nothing-matches-this',
    );

    filter('');
    expect(scroll().hidden).toBe(false);
    expect(emptyFiltered().hidden).toBe(true);
  });

  it('stands down on a page the server already filtered', () => {
    render('handbook');
    run();
    expect(document.querySelector('.spr-filter')?.hasAttribute('data-spr-live')).toBe(false);

    filter('');
    expect(shown()).toEqual(['handbook', 'specs']);
  });

  it('does nothing on a page with no table to narrow', () => {
    document.body.innerHTML = '<main><h1>Sync status</h1></main>';
    expect(run).not.toThrow();
  });
});

describe('the dashboard column', () => {
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).animate;
  });

  it('slides a branch shut where the page loads an island, and leaves its link a link', () => {
    const slide = { cancel: jest.fn(), onfinish: null as null | (() => void) };
    const animate = jest.fn(() => slide);
    Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
    window.matchMedia = jest.fn(() => ({ matches: false })) as unknown as typeof matchMedia;
    document.body.innerHTML = `
      <nav class="spr-nav"><ul class="spr-nav-root"><li class="spr-nav-branch">
        <details class="spr-nav-fold" open>
          <summary class="spr-nav-row"><a href="/-/status"><span>Sync status</span></a></summary>
          <ul><li class="spr-nav-leaf"><a href="/-/logs"><span>Logs</span></a></li></ul>
        </details>
      </li></ul></nav>`;
    run();
    const fold = document.querySelector<HTMLDetailsElement>('.spr-nav-fold')!;

    // The label navigates; only the rest of the row folds.
    const onLink = new MouseEvent('click', { bubbles: true, cancelable: true });
    fold.querySelector('a')!.dispatchEvent(onLink);
    expect(animate).not.toHaveBeenCalled();

    fold.querySelector('summary')!.click();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(fold.open).toBe(true);
    slide.onfinish!();
    expect(fold.open).toBe(false);
  });
});

describe('the dashboard column’s memory', () => {
  // The island only records; the server reads the cookie and draws the branch open,
  // so nothing is reopened after first paint (which flashed the column shut and open)
  const column = (open: boolean) => `
    <nav class="spr-nav"><ul class="spr-nav-root"><li class="spr-nav-branch">
      <details class="spr-nav-fold" data-spr-fold="config"${open ? ' open' : ''}>
        <summary class="spr-nav-row"><a href="/-/config"><span>Configuration</span></a></summary>
        <ul><li class="spr-nav-leaf"><a href="/-/config/identity"><span>Identity</span></a></li></ul>
      </details>
    </li></ul></nav>`;
  const recorded = () =>
    decodeURIComponent(/(?:^|; )speicher_dashboard_open=([^;]*)/.exec(document.cookie)?.[1] ?? '');

  beforeEach(() => {
    // The cookie is scoped to `/-/`, so it is only visible from a dashboard page
    window.history.pushState({}, '', '/-/status');
    document.cookie = 'speicher_dashboard_open=; path=/-/; max-age=0';
  });
  afterAll(() => window.history.pushState({}, '', '/'));

  it('records a branch open on load, so it stays open after the reader leaves it', () => {
    document.body.innerHTML = column(true);
    run();
    expect(recorded()).toBe('config');
  });

  it('records a branch the reader folded shut', async () => {
    document.body.innerHTML = column(true);
    run();
    document.querySelector<HTMLDetailsElement>('.spr-nav-fold')!.open = false;
    // `toggle` is queued, not dispatched inside the setter
    await new Promise((r) => setTimeout(r, 0));
    expect(recorded()).toBe('');
  });
});
