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
  return readFileSync(join(dir, manifest.setup), 'utf8');
})();

const CHECK = '/-/repositories?check=1';

const region = (inside: string, attributes = '') =>
  `<div data-spr-setup-fix-region${attributes}>${inside}</div>`;

const fix = (id: string, note = '') =>
  `<section class="spr-setup-fix" data-spr-setup-fix="${id}">${note}</section>`;

const row = (name: string, sync: string, checked = true) =>
  `<tr data-spr-repo-row="${name}" data-spr-source="gh"${checked ? ' data-spr-checked' : ''}>
     <th scope="row">${name}</th>
     <td data-spr-cell="file">present</td>
     <td data-spr-cell="access">–</td>
     <td data-spr-cell="readable">–</td>
     <td data-spr-cell="sync">${sync}</td>
   </tr>`;

const page = (top: string, rows: string, hidden = false) => `
  <main>
    ${top}
    <section data-spr-repository-step${hidden ? ' hidden' : ''}>
      <div class="spr-scroll"${rows ? '' : ' hidden'}>
        <table data-spr-repository-table><tbody>${rows}</tbody></table>
      </div>
    </section>
  </main>`;

function answer(html: string): void {
  fetchMock.mockResolvedValueOnce({ ok: true, text: async () => html });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
};

function run(): void {
  // eslint-disable-next-line no-new-func
  new Function(BUNDLE)();
}

let fetchMock: jest.Mock;
// The listeners a run of the bundle adds to the document, removed after each test
let listeners: [
  string,
  EventListenerOrEventListenerObject,
  boolean | AddEventListenerOptions | undefined,
][] = [];
const addListener = document.addEventListener.bind(document);

beforeEach(() => {
  listeners = [];
  jest
    .spyOn(document, 'addEventListener')
    .mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options) => {
      listeners.push([type, listener, options]);
      addListener(type, listener, options);
    });
  // jsdom has no CSS.escape, which the island finds rows by
  (globalThis as unknown as { CSS: { escape: (value: string) => string } }).CSS = {
    escape: (value) => value.replace(/["\\]/g, '\\$&'),
  };
  jest.useFakeTimers();
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  for (const [type, listener, options] of listeners) {
    document.removeEventListener(type, listener, options);
  }
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('the next step of the repositories page', () => {
  it('runs the checks once, and puts their step and their rows in place', async () => {
    document.body.innerHTML = page(
      region(
        fix('checking', '<p class="spr-setup-fix-note">updates</p>'),
        ` data-spr-check-href="${CHECK}"`,
      ),
      '',
      true,
    );
    answer(page(region(fix('no-file')), row('acme/handbook', 'never synced')));
    run();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(CHECK, expect.anything());
    expect(document.querySelector('[data-spr-setup-fix]')?.getAttribute('data-spr-setup-fix')).toBe(
      'no-file',
    );
    expect(document.querySelector('[data-spr-repo-row="acme/handbook"]')).not.toBeNull();
    // The table, hidden while it had no rows, is shown with them
    expect((document.querySelector('[data-spr-repository-step]') as HTMLElement).hidden).toBe(
      false,
    );
  });

  it('puts the rows in the order of the check, for new and for known rows', async () => {
    document.body.innerHTML = page(
      region(fix('checking'), ` data-spr-check-href="${CHECK}"`),
      `${row('acme/alpha', 'not published', false)}${row('acme/zebra', 'ok', false)}`,
    );
    answer(
      page(
        region(fix('done')),
        `${row('acme/new', 'never synced')}${row('acme/zebra', 'ok')}${row('acme/alpha', 'not published')}`,
      ),
    );

    run();
    await flush();

    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-spr-repo-row]'));
    expect(rows.map((each) => each.dataset.sprRepoRow)).toEqual([
      'acme/new',
      'acme/zebra',
      'acme/alpha',
    ]);
  });

  it('offers to check again when the check does not finish', async () => {
    document.body.innerHTML = page(
      region(
        fix('checking', '<p class="spr-setup-fix-note">updates</p>'),
        ` data-spr-check-href="${CHECK}"`,
      ),
      '',
      true,
    );
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    run();
    await flush();

    const note = document.querySelector('.spr-setup-fix-note');
    expect(note?.textContent).toBe('The check did not finish. Check again');
    expect(note?.querySelector('a')?.getAttribute('href')).toBe(CHECK);
  });

  it('checks again when the refresh finds a row that changed', async () => {
    document.body.innerHTML = page(region(fix('syncing')), row('acme/handbook', 'never synced'));
    run();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    // The refresh has no checks, so its step is pending; the sync of a row moved on
    answer(
      page(
        region(fix('checking'), ` data-spr-check-href="${CHECK}"`),
        row('acme/handbook', 'ok', false),
      ),
    );
    answer(page(region(''), row('acme/handbook', 'ok')));
    jest.advanceTimersByTime(10_000);
    await flush();

    expect(fetchMock).toHaveBeenNthCalledWith(2, CHECK, expect.anything());
    expect(document.querySelector('[data-spr-setup-fix]')).toBeNull();
    expect(document.querySelector('[data-spr-cell="sync"]')?.textContent).toBe('ok');
  });

  it('keeps the step it has when the refresh changed nothing', async () => {
    document.body.innerHTML = page(region(fix('no-grant')), row('acme/handbook', 'ok'));
    run();
    answer(
      page(
        region(fix('checking'), ` data-spr-check-href="${CHECK}"`),
        row('acme/handbook', 'ok', false),
      ),
    );
    jest.advanceTimersByTime(10_000);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-spr-setup-fix]')?.getAttribute('data-spr-setup-fix')).toBe(
      'no-grant',
    );
  });

  it('does not check again when the tab is shown again', async () => {
    document.body.innerHTML = page(region(fix('no-grant')), row('acme/handbook', 'ok'));
    run();
    answer(
      page(
        region(fix('checking'), ` data-spr-check-href="${CHECK}"`),
        row('acme/handbook', 'ok', false),
      ),
    );

    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(fetchMock).not.toHaveBeenCalledWith(CHECK, expect.anything());
  });

  it('asks GitHub again when the tab is shown again on a step done on GitHub', async () => {
    document.body.innerHTML = `
      <form action="/-/repositories" data-spr-refresh>
        <input type="hidden" name="check" value="1">
        <input type="hidden" name="fresh" value="1">
        <button type="submit"><svg></svg><span>Refresh</span></button>
      </form>
      ${page(region(fix('create-repository')), '', true)}`;
    run();
    answer(page(region(fix('no-file')), row('acme/handbook', 'not published')));

    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/-/repositories?check=1&fresh=1', expect.anything());
    expect(document.querySelector('[data-spr-setup-fix]')?.getAttribute('data-spr-setup-fix')).toBe(
      'no-file',
    );
    expect(document.querySelector('[data-spr-repo-row="acme/handbook"]')).not.toBeNull();
  });

  it('takes out the rows a check no longer answers with', async () => {
    document.body.innerHTML = page(
      region(fix('checking'), ` data-spr-check-href="${CHECK}"`),
      `${row('acme/deleted', 'ok', false)}${row('acme/wiki', 'ok')}`,
    );
    answer(page(region(fix('no-file')), row('acme/wiki', 'ok')));
    run();
    await flush();

    expect(document.querySelector('[data-spr-repo-row="acme/deleted"]')).toBeNull();
    expect(document.querySelector('[data-spr-repo-row="acme/wiki"]')).not.toBeNull();
  });

  it('takes out the synced rows the refresh no longer has, but leaves the rows of a check to the checks', async () => {
    document.body.innerHTML = page(
      region(fix('no-file')),
      `${row('acme/purged', 'ok', false)}${row('acme/empty', 'never synced')}`,
    );
    run();
    answer(page(region(fix('checking'), ` data-spr-check-href="${CHECK}"`), ''));
    answer(page(region(fix('no-file')), row('acme/empty', 'never synced')));
    jest.advanceTimersByTime(10_000);
    await flush();

    expect(document.querySelector('[data-spr-repo-row="acme/purged"]')).toBeNull();
    expect(document.querySelector('[data-spr-repo-row="acme/empty"]')).not.toBeNull();
    // A row taken out is a change, which the checks are run again for
    expect(fetchMock).toHaveBeenLastCalledWith(CHECK, expect.anything());
  });

  it('asks for the next step again once the jobs it waits for ended, though no row changed', async () => {
    document.body.innerHTML = page(region(fix('discovering')), row('acme/wiki', 'never synced'));
    document.querySelector('[data-spr-repository-step]')?.setAttribute('data-spr-busy', '');
    run();
    answer(
      page(
        region(fix('checking'), ` data-spr-check-href="${CHECK}"`),
        row('acme/wiki', 'never synced', false),
      ),
    );
    answer(page(region(fix('discover')), row('acme/wiki', 'never synced')));
    jest.advanceTimersByTime(3_000);
    await flush();

    expect(fetchMock).toHaveBeenNthCalledWith(2, CHECK, expect.anything());
    expect(document.querySelector('[data-spr-setup-fix]')?.getAttribute('data-spr-setup-fix')).toBe(
      'discover',
    );
  });

  const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

  it('posts the action of a step that runs by itself once, and checks again', async () => {
    const discover = fix(
      'discover',
      `<form method="post" action="/-/discover" data-spr-auto="now">
         <input type="hidden" name="back" value="repositories">
         <input type="hidden" name="source" value="gh">
       </form>`,
    );
    const pending = region(fix('checking'), ` data-spr-check-href="${CHECK}"`);
    document.body.innerHTML = page(pending, '', true);
    answer(page(region(discover), row('acme/wiki', 'never synced')));
    answer('{}');
    answer(page(pending, row('acme/wiki', 'never synced', false)));
    answer(page(region(discover), row('acme/wiki', 'never synced')));
    run();
    await flush();

    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe('/-/discover');
    expect(String(posts()[0][1].body)).toBe('back=repositories&source=gh');
    expect(fetchMock).toHaveBeenLastCalledWith(CHECK, expect.anything());
  });

  it('syncs again when the tab is shown again on a step with a sync to run', async () => {
    const noPage = fix(
      'no-page',
      `<form method="post" action="/-/sync" data-spr-auto="on-return">
         <input type="hidden" name="namespace" value="acme">
         <input type="hidden" name="slug" value="wiki">
       </form>`,
    );
    document.body.innerHTML = page(region(noPage), row('acme/wiki', 'ok'));
    run();
    await flush();
    expect(posts()).toHaveLength(0);

    answer('{}');
    answer(
      page(
        region(fix('checking'), ` data-spr-check-href="${CHECK}"`),
        row('acme/wiki', 'ok', false),
      ),
    );
    answer(page(region(fix('syncing')), row('acme/wiki', 'queued')));
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe('/-/sync');
    expect(String(posts()[0][1].body)).toBe('namespace=acme&slug=wiki');
    expect(document.querySelector('[data-spr-setup-fix]')?.getAttribute('data-spr-setup-fix')).toBe(
      'syncing',
    );
  });

  describe('Refresh button', () => {
    const REFRESH = `
      <form action="/-/repositories" data-spr-refresh>
        <input type="hidden" name="check" value="1">
        <input type="hidden" name="fresh" value="1">
        <button type="submit"><svg></svg><span>Refresh</span></button>
      </form>`;
    const button = () => document.querySelector('[data-spr-refresh] button') as HTMLButtonElement;
    const icon = () => button().querySelector('svg') as SVGElement;

    function pending(): (html: string) => void {
      let finish: (value: { ok: boolean; text: () => Promise<string> }) => void = () => {};
      fetchMock.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      return (html) => finish({ ok: true, text: async () => html });
    }

    it('runs the checks in place, asking GitHub for everything, and shows the run', async () => {
      document.body.innerHTML = `${REFRESH}${page(region(''), row('acme/handbook', 'ok'))}`;
      const finish = pending();
      run();

      const submit = new Event('submit', { bubbles: true, cancelable: true });
      document.querySelector('[data-spr-refresh]')?.dispatchEvent(submit);
      await flush();
      expect(submit.defaultPrevented).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith('/-/repositories?check=1&fresh=1', expect.anything());
      expect(button().disabled).toBe(true);
      expect(button().textContent).toBe('Refreshing…');
      expect(icon().classList.contains('spr-spin')).toBe(true);

      finish(page(region(fix('no-grant')), row('acme/wiki', 'never synced')));
      await flush();
      expect(document.querySelector('[data-spr-repo-row="acme/wiki"]')).not.toBeNull();
      expect(button().disabled).toBe(false);
      expect(button().textContent).toBe('Refresh');
      expect(icon().classList.contains('spr-spin')).toBe(false);
    });

    it('syncs again on a step with a sync to run, rather than only asking GitHub', async () => {
      const noPage = fix(
        'no-page',
        `<form method="post" action="/-/sync" data-spr-auto="on-return">
           <input type="hidden" name="namespace" value="acme">
           <input type="hidden" name="slug" value="wiki">
         </form>`,
      );
      document.body.innerHTML = `${REFRESH}${page(region(noPage), row('acme/wiki', 'ok'))}`;
      run();
      answer('{}');
      answer(
        page(
          region(fix('checking'), ` data-spr-check-href="${CHECK}"`),
          row('acme/wiki', 'ok', false),
        ),
      );
      answer(page(region(fix('syncing')), row('acme/wiki', 'queued')));

      document
        .querySelector('[data-spr-refresh]')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();

      expect(fetchMock).toHaveBeenNthCalledWith(1, '/-/sync', expect.anything());
      expect(fetchMock).not.toHaveBeenCalledWith(
        '/-/repositories?check=1&fresh=1',
        expect.anything(),
      );
      expect(
        document.querySelector('[data-spr-setup-fix]')?.getAttribute('data-spr-setup-fix'),
      ).toBe('syncing');
      expect(button().disabled).toBe(false);
    });

    it('shows the check the page starts with too, and stops when it fails', async () => {
      document.body.innerHTML = `${REFRESH}${page(
        region(fix('checking'), ` data-spr-check-href="${CHECK}"`),
        row('acme/handbook', 'ok', false),
      )}`;
      let fail: (reason: Error) => void = () => {};
      fetchMock.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
      run();
      await flush();
      expect(button().textContent).toBe('Refreshing…');
      expect(icon().classList.contains('spr-spin')).toBe(true);

      fail(new Error('offline'));
      await flush();
      expect(button().textContent).toBe('Refresh');
      expect(button().disabled).toBe(false);
    });
  });

  describe('Add repository modal', () => {
    const PENDING = 'spr-add-repository';
    const DISCOVER = '/-/discover';
    const OPEN = '<a href="#github" data-spr-add-open>Open on GitHub</a>';
    const CHECK_NOW = '<button type="button" data-spr-add-check>Check</button>';

    const repository = (name: string, create = false) => ({
      key: name,
      name,
      href: `https://github.com/${name}`,
      ...(create ? { create_href: `/create/${name}`, create_action: `/post/${name}` } : {}),
    });

    const rows = (known: ReturnType<typeof repository>[]) =>
      known
        .map(
          (each) => `<li data-spr-add-key="${each.key}">
            <a href="${each.href}">${each.name}</a>
            ${
              each.create_action
                ? `<a href="${each.create_href}" data-spr-config-file-action="${each.create_action}"
                      data-spr-config-file-repository="${each.name}">Create .speicher.yaml</a>`
                : ''
            }
          </li>`,
        )
        .join('');

    const panel = (id: string, known: ReturnType<typeof repository>[], action = OPEN) =>
      `<div data-spr-add-source="${id}" data-spr-known="${known.map((each) => each.key).join(' ')}">
        ${action}
        <template data-spr-add-rows>${rows(known)}</template>
      </div>`;

    const modal = (panels: string, pick = '') => `
      <details class="spr-modal" data-spr-add-repository data-spr-check-address="${CHECK}">
        <summary>Add repository</summary>
        <h2 data-spr-add-title>Add a repository</h2>
        <div data-spr-add-start>
          ${pick}
          ${panels}
        </div>
        <div data-spr-add-result hidden>
          <p data-spr-add-looking>Looking</p>
          <p data-spr-add-status hidden></p>
          <ul data-spr-add-found hidden></ul>
          <button type="button" data-spr-add-check>Check again</button>
        </div>
      </details>`;

    const details = () => document.querySelector('[data-spr-add-repository]') as HTMLDetailsElement;
    const title = () => document.querySelector('[data-spr-add-title]') as HTMLElement;
    const start = () => document.querySelector('[data-spr-add-start]') as HTMLElement;
    const result = () => document.querySelector('[data-spr-add-result]') as HTMLElement;
    const looking = () => document.querySelector('[data-spr-add-looking]') as HTMLElement;
    const status = () => document.querySelector('[data-spr-add-status]') as HTMLElement;
    const found = () => document.querySelector('[data-spr-add-found]') as HTMLElement;
    const again = () =>
      document.querySelector('[data-spr-add-result] [data-spr-add-check]') as HTMLButtonElement;
    const discovers = () => fetchMock.mock.calls.filter(([href]) => href === DISCOVER);

    function leftForGithub(keys: string[], source = 'gh', at = Date.now()): void {
      sessionStorage.setItem(PENDING, JSON.stringify({ source, keys, at }));
    }

    function shown(panels: string, pick = ''): void {
      document.body.innerHTML = page(`${region('')}${modal(panels, pick)}`, '');
    }

    const checked = (panels: string) => page(`${region('')}${modal(panels)}`, '');

    beforeEach(() => {
      sessionStorage.clear();
    });

    it('saves the repositories of the source when it leaves for GitHub', () => {
      shown(panel('gh', [repository('acme/handbook')]));
      run();

      const open = document.querySelector('[data-spr-add-open]') as HTMLAnchorElement;
      open.addEventListener('click', (event) => event.preventDefault());
      open.click();

      expect(JSON.parse(sessionStorage.getItem(PENDING) ?? '')).toMatchObject({
        source: 'gh',
        keys: ['acme/handbook'],
      });
    });

    it('opens again after GitHub, and offers to create the file of a new repository', async () => {
      leftForGithub(['acme/handbook']);
      shown(panel('gh', [repository('acme/handbook')]));
      answer(checked(panel('gh', [repository('acme/handbook'), repository('acme/wiki', true)])));
      fetchMock.mockResolvedValueOnce({ ok: true });

      run();
      await flush();

      expect(details().open).toBe(true);
      expect(start().hidden).toBe(true);
      expect(result().hidden).toBe(false);
      expect(title().textContent).toBe('New repositories');
      expect(looking().hidden).toBe(true);
      expect(status().textContent).toContain('a new repository in gh');
      expect(found().hidden).toBe(false);
      const items = found().querySelectorAll('li');
      expect(items).toHaveLength(1);
      expect(items[0].querySelector('a')?.getAttribute('href')).toBe(
        'https://github.com/acme/wiki',
      );
      const create = items[0].querySelector<HTMLAnchorElement>('[data-spr-config-file-action]');
      expect(create?.dataset.sprConfigFileAction).toBe('/post/acme/wiki');
      expect(create?.dataset.sprConfigFileRepository).toBe('acme/wiki');
      expect(sessionStorage.getItem(PENDING)).toBeNull();

      expect(discovers()).toHaveLength(1);
      const [, sent] = discovers()[0] as [string, { body: URLSearchParams }];
      expect(sent.body.get('source')).toBe('gh');
    });

    it('offers to check again when nothing is new, and asks for no discovery', async () => {
      leftForGithub(['acme/handbook']);
      shown(panel('gh', [repository('acme/handbook')]));
      answer(checked(panel('gh', [repository('acme/handbook')])));

      run();
      await flush();

      expect(status().textContent).toContain('no new repository in gh');
      expect(result().hidden).toBe(false);
      expect(found().hidden).toBe(true);
      expect(discovers()).toHaveLength(0);
    });

    it('still finds a repository on a second look', async () => {
      leftForGithub(['acme/handbook']);
      shown(panel('gh', [repository('acme/handbook')]));
      answer(checked(panel('gh', [repository('acme/handbook')])));
      run();
      await flush();

      answer(checked(panel('gh', [repository('acme/handbook'), repository('acme/wiki')])));
      fetchMock.mockResolvedValueOnce({ ok: true });
      again().click();
      await flush();

      expect(status().textContent).toContain('a new repository in gh');
      expect(found().querySelectorAll('li')).toHaveLength(1);
    });

    it('says so when the check does not finish', async () => {
      leftForGithub(['acme/handbook']);
      shown(panel('gh', [repository('acme/handbook')]));
      fetchMock.mockRejectedValueOnce(new Error('offline'));

      run();
      await flush();

      expect(status().textContent).toContain('could not finish');
      expect(again().disabled).toBe(false);
      expect(discovers()).toHaveLength(0);
    });

    it('stays closed for an entry that is too old', async () => {
      leftForGithub(['acme/handbook'], 'gh', Date.now() - 60 * 60 * 1000);
      shown(panel('gh', [repository('acme/handbook')]));

      run();
      await flush();

      expect(details().open).toBe(false);
      expect(sessionStorage.getItem(PENDING)).toBeNull();
    });

    it('opens on the source it left from', async () => {
      leftForGithub([], 'second');
      const pick = `<select data-spr-add-source-pick>
        <option value="first">first</option><option value="second">second</option>
      </select>`;
      shown(`${panel('first', [])}${panel('second', [])}`, pick);
      answer(checked(`${panel('first', [])}${panel('second', [repository('acme/wiki')])}`));
      fetchMock.mockResolvedValueOnce({ ok: true });

      run();
      await flush();

      const panels = document.querySelectorAll<HTMLElement>('[data-spr-add-source]');
      expect(panels[0].hidden).toBe(true);
      expect(panels[1].hidden).toBe(false);
      expect(status().textContent).toContain('a new repository in second');
    });

    it('checks on request when the App reads every repository', async () => {
      shown(panel('gh', [repository('acme/handbook')], CHECK_NOW));
      run();
      await flush();
      expect(start().hidden).toBe(false);
      expect(result().hidden).toBe(true);

      const known = [repository('acme/handbook'), repository('acme/wiki')];
      answer(checked(panel('gh', known, CHECK_NOW)));
      fetchMock.mockResolvedValueOnce({ ok: true });
      details().open = true;
      (document.querySelector('[data-spr-add-source] [data-spr-add-check]') as HTMLElement).click();
      await flush();

      expect(result().hidden).toBe(false);
      expect(status().textContent).toContain('a new repository in gh');
    });

    it('shows only the source that is picked', () => {
      const pick = `<select data-spr-add-source-pick>
        <option value="first">first</option><option value="second">second</option>
      </select>`;
      shown(`${panel('first', [])}${panel('second', [])}`, pick);
      run();

      const panels = document.querySelectorAll<HTMLElement>('[data-spr-add-source]');
      expect(panels[0].hidden).toBe(false);
      expect(panels[1].hidden).toBe(true);

      const select = document.querySelector('select') as HTMLSelectElement;
      select.value = 'second';
      select.dispatchEvent(new Event('change', { bubbles: true }));

      expect(panels[0].hidden).toBe(true);
      expect(panels[1].hidden).toBe(false);
    });

    it('goes back to its first screen when it is closed', async () => {
      leftForGithub([]);
      shown(panel('gh', []));
      answer(checked(panel('gh', [repository('acme/wiki')])));
      fetchMock.mockResolvedValueOnce({ ok: true });
      run();
      await flush();
      expect(result().hidden).toBe(false);

      details().open = false;
      details().dispatchEvent(new Event('toggle'));

      expect(start().hidden).toBe(false);
      expect(result().hidden).toBe(true);
      expect(title().textContent).toBe('Add a repository');
      expect(found().children).toHaveLength(0);
    });

    describe('a source the page was drawn without its installation', () => {
      const LOOKUP = '/-/repositories?installations=1';
      const looked = (panels: string) =>
        modal(panels).replace(
          'data-spr-add-repository ',
          `data-spr-add-repository data-spr-lookup-address="${LOOKUP}" `,
        );
      const asking = `<div data-spr-add-source="gh" data-spr-known="" data-spr-add-pending>
        <p data-spr-add-lookup>Looking up the GitHub App…</p>
        <template data-spr-add-rows></template>
      </div>`;

      it('asks for it before the checks, and offers GitHub without waiting for them', async () => {
        document.body.innerHTML = page(
          `${region('', ` data-spr-check-href="${CHECK}"`)}${looked(asking)}`,
          '',
        );
        answer(checked(panel('gh', [])));
        let finish: (value: unknown) => void = () => {};
        fetchMock.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

        run();
        await flush();

        expect(fetchMock.mock.calls[0][0]).toBe(LOOKUP);
        expect(fetchMock.mock.calls[1][0]).toBe(CHECK);
        expect(document.querySelector('[data-spr-add-open]')).not.toBeNull();
        expect(document.querySelector('[data-spr-add-pending]')).toBeNull();

        finish({ ok: true, text: async () => checked(panel('gh', [])) });
        await flush();
      });

      it('asks for nothing when the page knows every installation', async () => {
        document.body.innerHTML = page(`${region('')}${looked(panel('gh', []))}`, '');

        run();
        await flush();

        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('says so when the lookup fails, rather than looking forever', async () => {
        document.body.innerHTML = page(`${region('')}${looked(asking)}`, '');
        fetchMock.mockRejectedValueOnce(new Error('offline'));

        run();
        await flush();

        expect(document.querySelector('[data-spr-add-lookup]')?.textContent).toContain('reload');
      });
    });

    it('takes what a check knows of the source, which the page drew without it', async () => {
      document.body.innerHTML = page(
        `${region('', ` data-spr-check-href="${CHECK}"`)}${modal(panel('gh', [], ''))}`,
        '',
      );
      expect(document.querySelector('[data-spr-add-open]')).toBeNull();
      answer(checked(panel('gh', [])));

      run();
      await flush();

      expect(document.querySelector('[data-spr-add-open]')).not.toBeNull();
    });

    it('gives way to the modal of a new .speicher.yaml', async () => {
      leftForGithub([]);
      shown(panel('gh', []));
      answer(checked(panel('gh', [repository('acme/wiki', true)])));
      fetchMock.mockResolvedValueOnce({ ok: true });
      run();
      await flush();

      const create = found().querySelector('[data-spr-config-file-action]') as HTMLAnchorElement;
      create.addEventListener('click', (event) => event.preventDefault());
      create.click();

      expect(details().open).toBe(false);
    });
  });
});
