/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The built bundle, not the source: what a browser runs is what is asserted
const BUNDLE = (() => {
  const dir = join(__dirname, '../../dist/client');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<
    string,
    string
  >;
  return readFileSync(join(dir, manifest['repo-status']), 'utf8');
})();

function render(syncing: boolean): void {
  document.body.innerHTML = `
    <main>
      <div class="spr-page-head">
        <h1 class="spr-titled">copetence/handbook</h1>
        <form method="post" action="/-/sync" class="spr-form spr-index-op spr-page-op">
          ${
            syncing
              ? '<button type="submit" disabled aria-busy="true" data-spr-syncing>Syncing…</button>'
              : '<button type="submit">Sync now</button>'
          }
        </form>
      </div>
    </main>`;
}

function run(): void {
  // eslint-disable-next-line no-new-func
  new Function(BUNDLE)();
}

let fetchMock: jest.Mock;
const answer = (syncing: boolean) => ({ ok: true, json: async () => ({ syncing }) });

/** Advances past one poll and lets its promise chain settle */
async function poll(): Promise<void> {
  await jest.advanceTimersByTimeAsync(3_000);
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock = jest.fn().mockResolvedValue(answer(true));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  jest.useRealTimers();
});

describe("a run's findings count", () => {
  function renderRuns(): void {
    document.body.innerHTML = `
      <main>
        <table class="spr-table"><tbody>
          <tr><td><a href="/-/status/copetence/handbook/runs/1#findings" aria-expanded="false" aria-controls="run-findings-0" data-spr-findings-toggle>1</a></td></tr>
          <tr id="run-findings-0" hidden><td>unknown-group</td></tr>
        </tbody></table>
      </main>`;
  }
  const toggle = () => document.querySelector('[data-spr-findings-toggle]') as HTMLAnchorElement;
  const row = () => document.getElementById('run-findings-0') as HTMLElement;
  const press = (): boolean => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    toggle().dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('opens the findings under the row and closes them again, staying on the page', () => {
    renderRuns();
    run();
    expect(toggle().getAttribute('role')).toBe('button');

    expect(press()).toBe(true);
    expect(row().hidden).toBe(false);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');

    press();
    expect(row().hidden).toBe(true);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the repository status island', () => {
  it('asks nothing when no sync is in flight', async () => {
    render(false);
    run();
    await poll();
    await poll();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the page's own JSON while a sync is in flight, and keeps asking", async () => {
    render(true);
    run();
    expect(fetchMock).not.toHaveBeenCalled();

    await poll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(window.location.pathname);
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');

    await poll();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops asking once the sync has landed', async () => {
    render(true);
    fetchMock.mockResolvedValue(answer(false));
    run();
    await poll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The reload is jsdom's to refuse; what is observable is that polling ended
    await poll();
    await poll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps asking through a failed poll, which says nothing about the sync', async () => {
    render(true);
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    run();
    await poll();
    await poll();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
