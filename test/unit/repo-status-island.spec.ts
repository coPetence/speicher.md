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
