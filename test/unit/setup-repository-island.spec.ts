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

beforeEach(() => {
  // jsdom has no CSS.escape, which the island finds rows by
  (globalThis as unknown as { CSS: { escape: (value: string) => string } }).CSS = {
    escape: (value) => value.replace(/["\\]/g, '\\$&'),
  };
  jest.useFakeTimers();
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
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
});
