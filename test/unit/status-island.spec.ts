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

// Three repositories: two ok, one not published, under two owners
const FACETS = JSON.stringify([
  { state: 'ok', owner: 'copetence', source: 'gh', pages: '1-9' },
  { state: 'ok', owner: 'northwind-engineering', source: 'gh', pages: '1-9' },
  { state: 'unpublished', owner: 'copetence', source: 'gh', pages: 'none' },
]).replace(/"/g, '&quot;');

function render(query = ''): void {
  document.body.innerHTML = `
    <main>
      <div class="spr-index-bar">
        <form class="spr-form spr-filter" method="get" action="/-/status" data-spr-filter>
          <input id="filter-status" type="search" name="q" value="${query}" aria-label="Find a repository">
          <details class="spr-modal spr-filter-modal">
            <summary aria-label="Filter"></summary>
            <div class="spr-modal-panel spr-filter-dialog" data-spr-facets="${FACETS}">
              <button type="button" data-spr-filter-clear><span data-spr-applied>1</span> applied</button>
              <button type="button" data-spr-group="state" aria-current="true">State <span data-spr-group-count>1</span></button>
              <button type="button" data-spr-group="owner">Owner <span data-spr-group-count></span></button>
              <fieldset data-spr-group-panel="state">
                <legend><span data-spr-selected>1</span> selected <button type="button" data-spr-select-all>Select all</button></legend>
                <label data-spr-option="ok"><input type="checkbox" name="state" value="ok" checked> ok</label>
                <label data-spr-option="not published"><input type="checkbox" name="state" value="unpublished"> not published</label>
              </fieldset>
              <fieldset data-spr-group-panel="owner">
                <legend><span data-spr-selected>0</span> selected <button type="button" data-spr-select-all>Select all</button></legend>
                <input type="search" data-spr-option-search>
                <label data-spr-option="copetence"><input type="checkbox" name="owner" value="copetence"> copetence</label>
                <label data-spr-option="northwind-engineering"><input type="checkbox" name="owner" value="northwind-engineering"> northwind-engineering</label>
              </fieldset>
              <strong data-spr-results>2</strong>
              <button type="button" data-spr-filter-cancel>Cancel</button>
              <button type="submit">Apply filters</button>
              <input type="hidden" name="f" value="1">
            </div>
          </details>
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

  describe('the filter dialog', () => {
    const modal = () => document.querySelector('.spr-filter-modal') as HTMLDetailsElement;
    const panel = (key: string) =>
      document.querySelector(`[data-spr-group-panel="${key}"]`) as HTMLElement;
    const box = (value: string) =>
      document.querySelector(`input[value="${value}"]`) as HTMLInputElement;
    const text = (selector: string) => document.querySelector(selector)?.textContent;
    const tick = (value: string, checked = true) => {
      box(value).checked = checked;
      box(value).dispatchEvent(new Event('change', { bubbles: true }));
    };
    const click = (selector: string) =>
      (document.querySelector(selector) as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    // The toggle event is queued, so it lands after the current task
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('shows one group at a time, the one picked on the left', () => {
      render();
      run();
      expect(panel('state').hasAttribute('data-spr-current')).toBe(true);
      expect(panel('owner').hasAttribute('data-spr-current')).toBe(false);

      click('[data-spr-group="owner"]');

      expect(panel('owner').hasAttribute('data-spr-current')).toBe(true);
      expect(panel('state').hasAttribute('data-spr-current')).toBe(false);
      expect(document.querySelector('[data-spr-group="owner"]')?.getAttribute('aria-current')).toBe(
        'true',
      );
    });

    it('counts the results of a choice before it is applied', () => {
      render();
      run();
      expect(text('[data-spr-results]')).toBe('2');

      tick('unpublished');
      expect(text('[data-spr-results]')).toBe('3');

      tick('northwind-engineering');
      expect(text('[data-spr-results]')).toBe('1');
      expect(text('[data-spr-applied]')).toBe('2');
      expect(text('[data-spr-group="owner"] [data-spr-group-count]')).toBe('1');
    });

    it('selects every choice the search leaves, and clears every choice', () => {
      render();
      run();
      const search = document.querySelector('[data-spr-option-search]') as HTMLInputElement;
      search.value = 'north';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      click('[data-spr-group-panel="owner"] [data-spr-select-all]');

      expect(box('northwind-engineering').checked).toBe(true);
      expect(box('copetence').checked).toBe(false);

      click('[data-spr-filter-clear]');
      expect(box('ok').checked).toBe(false);
      expect(box('northwind-engineering').checked).toBe(false);
      expect(text('[data-spr-applied]')).toBe('0');
      expect(text('[data-spr-results]')).toBe('3');
    });

    it('puts the choices back when closed without applying', async () => {
      render();
      run();
      modal().open = true;
      await settle();
      tick('ok', false);
      tick('unpublished');

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();

      expect(modal().open).toBe(false);
      expect(box('ok').checked).toBe(true);
      expect(box('unpublished').checked).toBe(false);
      expect(text('[data-spr-results]')).toBe('2');
    });
  });

  it('does nothing on a page with no table to narrow', () => {
    document.body.innerHTML = '<main><h1>Sync status</h1></main>';
    expect(run).not.toThrow();
  });
});

describe('the refresh', () => {
  const PROBLEMS =
    '<tr data-spr-row="copetence handbook gh github"><td><details data-spr-repo="copetence/handbook"><summary>2 problems</summary></details></td></tr>';
  const NEW_ROW = '<tr data-spr-row="acme wiki gh github"><th><a href="#">acme/wiki</a></th></tr>';

  afterEach(() => {
    jest.useRealTimers();
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  function serve(html: string): jest.Mock {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => html });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    return fetchMock;
  }

  it('swaps in the rows that changed, and keeps what the reader typed and opened', async () => {
    jest.useFakeTimers();
    render();
    document.querySelector('tbody')!.insertAdjacentHTML('beforeend', PROBLEMS);
    const fresh = document.documentElement.outerHTML.replace('</tbody>', `${NEW_ROW}</tbody>`);
    const fetchMock = serve(fresh);
    run();
    filter('handbook');
    (document.querySelector('details[data-spr-repo]') as HTMLDetailsElement).open = true;

    await jest.advanceTimersByTimeAsync(10_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows().map((row) => row.dataset.sprRow?.split(' ')[1])).toContain('wiki');
    expect(shown()).toEqual(['handbook', 'handbook']);
    expect((document.querySelector('details[data-spr-repo]') as HTMLDetailsElement).open).toBe(
      true,
    );
  });

  it('leaves the page alone when the answer has no table, such as a sign-in page', async () => {
    jest.useFakeTimers();
    render();
    serve('<html><body><h1>Sign in</h1></body></html>');
    run();

    await jest.advanceTimersByTimeAsync(10_000);

    expect(shown()).toEqual(['handbook', 'specs']);
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
