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
  return readFileSync(join(dir, manifest.config), 'utf8');
})();

function render(pending = false): HTMLFormElement {
  document.body.innerHTML = `
    <main>
      <form class="spr-config" method="post" action="/-/config/branding"
            data-spr-config="branding" ${pending ? 'data-spr-pending' : ''}>
        <input name="brand.name" value="Docs">
        <input type="checkbox" name="theme.dense" value="on">
        <input name="newname:auth.providers" type="text" data-spr-transient>
        <div class="spr-config-actions">
          <button type="submit" name="intent" value="check" class="spr-config-check">Check changes</button>
          <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
        </div>
      </form>
    </main>`;
  return document.querySelector('form') as HTMLFormElement;
}

function renderDraft(): HTMLFormElement {
  document.body.innerHTML = `
    <main>
      <form class="spr-config" method="post" action="/-/config/identity/test?kind=entra"
            data-spr-config="identity/test" data-spr-pending>
        <input name="auth.providers.test.issuer" value="" required pattern="[a-z0-9-]{3,}">
        <div class="spr-config-actions">
          <button type="submit" name="intent" value="check" class="spr-config-check">Check changes</button>
          <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
        </div>
      </form>
    </main>`;
  return document.querySelector('form') as HTMLFormElement;
}

function renderReshaping(): HTMLFormElement {
  document.body.innerHTML = `
    <main>
      <form class="spr-config" method="post" action="/-/config/storage" data-spr-config="storage">
        <input type="hidden" name="__was:assets.driver" value="filesystem">
        <select name="assets.driver" data-spr-reshapes>
          <option value="filesystem" selected>Filesystem volume</option>
          <option value="azure">Azure Blob Storage</option>
        </select>
        <input name="assets.path" value="./var/assets">
        <div class="spr-config-actions">
          <button type="submit" name="intent" value="check" class="spr-config-check">Check changes</button>
          <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
        </div>
      </form>
    </main>`;
  return document.querySelector('form') as HTMLFormElement;
}

function renderRoundTrip(): HTMLFormElement {
  document.body.innerHTML = `
    <main>
      <form class="spr-config" method="post" action="/-/config/groups/eng"
            data-spr-config="groups/eng" data-spr-pending data-spr-holds-work>
        <input name="groups.eng.0.id" value="a-group-id-typed-here">
        <div class="spr-config-actions">
          <button type="submit" name="intent" value="check" class="spr-config-check">Check changes</button>
          <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
        </div>
      </form>
    </main>`;
  return document.querySelector('form') as HTMLFormElement;
}

const form = () => document.querySelector('form') as HTMLFormElement;
const save = () => document.querySelector('.spr-config-save') as HTMLButtonElement;
const status = () => document.querySelector('.spr-config-state') as HTMLParagraphElement | null;
const pending = () => form().hasAttribute('data-spr-pending');

// Presses Save, and says whether a submission got through. One that does is stopped
// here, since jsdom cannot navigate
function pressSave(): boolean {
  let submitted = false;
  const stop = (event: Event): void => {
    submitted = true;
    event.preventDefault();
  };
  form().addEventListener('submit', stop);
  save().click();
  form().removeEventListener('submit', stop);
  return submitted;
}

function type(name: string, value: string): void {
  const control = form().querySelector(`[name="${name}"]`) as HTMLInputElement;
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
}

function run(): void {
  // eslint-disable-next-line no-new-func
  new Function(BUNDLE)();
}

const DEBOUNCE_MS = 400;
const SLOW_CHECK_MS = 100;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

async function settle(): Promise<void> {
  jest.advanceTimersByTime(DEBOUNCE_MS);
  await flush();
  jest.advanceTimersByTime(SLOW_CHECK_MS * 2);
  await flush();
}

function deferredFetch(): { resolve: (value: unknown) => void } {
  let release!: (value: unknown) => void;
  fetchMock.mockReturnValue(
    new Promise((r) => {
      release = r;
    }),
  );
  return { resolve: release };
}

let fetchMock: jest.Mock;

let registered: [string, EventListenerOrEventListenerObject][] = [];
const realAddEventListener = window.addEventListener;

beforeEach(() => {
  registered = [];
  window.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    registered.push([type, listener]);
    realAddEventListener.call(window, type, listener, options);
  }) as typeof window.addEventListener;
  jest.useFakeTimers();
  fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      error: null,
      verdict: { changed: [], rebuild: false, effect: 'hot', hotReloadAvailable: true },
    }),
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  for (const [type, listener] of registered) window.removeEventListener(type, listener);
  window.addEventListener = realAddEventListener;
  jest.useRealTimers();
});

describe('the question asked on the way out', () => {
  const leaving = (): boolean => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('lets a page reached by Add go, because nothing on it was typed here', () => {
    renderDraft();
    run();

    expect(pending()).toBe(true);
    expect(leaving()).toBe(false);
  });

  it('stops one that would take a typed value with it', () => {
    render();
    run();
    type('brand.name', 'Handbuch');

    expect(leaving()).toBe(true);
  });

  it('stops one leaving a draft somebody has started filling in', () => {
    renderDraft();
    run();
    type('auth.providers.test.issuer', 'okta-test');

    expect(leaving()).toBe(true);
  });

  it('stops one leaving a page that came back from a submission', () => {
    renderRoundTrip();
    run();

    expect(leaving()).toBe(true);
  });

  it('asks nothing when the page is leaving because it was submitted', () => {
    renderRoundTrip();
    run();
    form().dispatchEvent(new Event('submit'));

    expect(leaving()).toBe(false);
  });
});

describe('the check a section offers', () => {
  function renderCheck(): HTMLElement {
    document.body.innerHTML = `
      <main>
        <p class="spr-note spr-note-idle spr-section-status" data-spr-check="/-/config/storage?check=1">
          <span data-spr-check-text><a href="/-/config/storage?check=1">Check the connection</a></span>
        </p>
      </main>`;
    return document.querySelector('.spr-section-status') as HTMLElement;
  }

  const note = () => document.querySelector('.spr-section-status') as HTMLElement;
  const words = () =>
    (document.querySelector('[data-spr-check-text]') as HTMLElement).textContent ?? '';

  it('follows the link on load, so nobody has to press it', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        section: {
          status: { level: 'ok', label: 'The volume is writable', detail: '/srv/assets' },
        },
      }),
    });
    renderCheck();
    run();

    expect(words()).toBe('Checking…');
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/-/config/storage?check=1', expect.anything());
    expect(words()).toBe('The volume is writable: /srv/assets');
    expect(note().className).toContain('spr-note-ok');
  });

  it('draws a refusal as the refusal it is', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        section: {
          status: { level: 'fail', label: 'Not configured', detail: 'account_key is required' },
        },
      }),
    });
    renderCheck();
    run();
    await flush();

    expect(note().className).toContain('spr-note-fail');
    expect(words()).toContain('account_key is required');
  });

  it('puts the link back when it cannot ask at all', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    renderCheck();
    run();
    await flush();

    expect(note().className).toContain('spr-note-idle');
    expect(document.querySelector('[data-spr-check-text] a')?.textContent).toBe(
      'Check the connection',
    );
  });

  it('asks nothing on a page that offers no check', async () => {
    render();
    run();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the check a field offers', () => {
  function renderFieldCheck(path = 'auth.providers.entra.directory.type'): void {
    document.body.innerHTML = `
      <main>
        <p class="spr-note spr-note-idle" data-spr-check="/-/config/identity/entra?check=1" data-spr-check-at="${path}">
          <span data-spr-check-text><a href="/-/config/identity/entra?check=1">Check the connection</a></span>
        </p>
      </main>`;
  }

  const note = () => document.querySelector('[data-spr-check]') as HTMLElement;
  const words = () =>
    (document.querySelector('[data-spr-check-text]') as HTMLElement).textContent ?? '';

  const answer = () => ({
    ok: true,
    json: async () => ({
      section: {
        status: undefined,
        cards: [
          {
            fields: [
              { path: 'auth.providers.entra.issuer' },
              {
                path: 'auth.providers.entra.directory.type',
                status: { level: 'ok', label: 'Connected', detail: '' },
              },
            ],
          },
        ],
      },
    }),
  });

  it('reads the status off the field it names, however deep it sits', async () => {
    fetchMock.mockResolvedValue(answer());
    renderFieldCheck();
    run();
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/-/config/identity/entra?check=1', expect.anything());
    expect(words()).toBe('Connected');
    expect(note().className).toContain('spr-note-ok');
  });

  it('keeps the classes the server drew it with', async () => {
    fetchMock.mockResolvedValue(answer());
    renderFieldCheck();
    run();
    await flush();

    expect(note().className).toContain('spr-note-ok');
    expect(note().className).not.toContain('spr-note-idle');
    expect(note().className).not.toContain('spr-section-status');
  });

  it('puts the link back when the answer carries nothing about this field', async () => {
    fetchMock.mockResolvedValue(answer());
    renderFieldCheck('auth.providers.other.directory.type');
    run();
    await flush();

    expect(note().className).toContain('spr-note-idle');
    expect(document.querySelector('[data-spr-check-text] a')?.textContent).toBe(
      'Check the connection',
    );
  });
});

describe('the save bar', () => {
  it('marks the form as live, so the sheet can hide what it now drives', () => {
    render();
    run();
    expect(form().hasAttribute('data-spr-live')).toBe(true);
  });

  it('goes and gets the controls a different driver needs, rather than checking a form nothing can fix', async () => {
    const submitted: SubmitEvent[] = [];
    renderReshaping();
    run();
    form().addEventListener('submit', (event) => {
      event.preventDefault();
      submitted.push(event as SubmitEvent);
    });

    const driver = form().querySelector('select') as HTMLSelectElement;
    driver.value = 'azure';
    driver.dispatchEvent(new Event('change', { bubbles: true }));

    expect(submitted.length).toBe(1);
    expect(submitted[0].submitter).toBe(null);
  });

  it('names the file picked to replace a stored one, since a file input cannot say what it holds', () => {
    document.body.innerHTML = `
      <main>
        <form class="spr-config" method="post" action="/-/config/branding" data-spr-config="branding">
          <div class="spr-stored">
            <span class="spr-stored-what">logo.svg, 2 KB</span>
            <span class="spr-stored-picked" data-spr-picked hidden></span>
            <input type="file" name="brand.logo" id="f-brand.logo">
          </div>
          <div class="spr-config-actions">
            <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
          </div>
        </form>
      </main>`;
    run();

    const picker = form().querySelector('input[type="file"]') as HTMLInputElement;
    const picked = form().querySelector('[data-spr-picked]') as HTMLElement;
    const choose = (files: { name: string; size: number }[]): void => {
      Object.defineProperty(picker, 'files', { value: files, configurable: true });
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    };

    choose([{ name: 'new-logo.png', size: 1200 }]);
    expect(picked.textContent).toBe('new-logo.png');
    expect(picked.hidden).toBe(false);

    // Cancelling the picker empties it, and an empty name is not left on screen
    choose([]);
    expect(picked.textContent).toBe('');
    expect(picked.hidden).toBe(true);
  });

  it('puts the page origin in front of a path offered to copy, and leaves a full URL alone', () => {
    document.body.innerHTML = `
      <main>
        <form class="spr-config" method="post" action="/-/config/sources/gh" data-spr-config="sources/gh">
          <span class="spr-copyable" data-spr-origin-path>
            <code>/-/hooks/gh</code>
            <button type="button" class="spr-copy" data-spr-clipboard="/-/hooks/gh" hidden></button>
          </span>
          <span class="spr-copyable">
            <code>https://docs.acme.example/-/hooks/other</code>
            <button type="button" class="spr-copy" data-spr-clipboard="https://docs.acme.example/-/hooks/other" hidden></button>
          </span>
          <div class="spr-config-actions">
            <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
          </div>
        </form>
      </main>`;
    run();

    const [path, full] = Array.from(form().querySelectorAll('.spr-copyable'));
    expect(path.querySelector('code')?.textContent).toBe(`${location.origin}/-/hooks/gh`);
    expect((path.querySelector('button') as HTMLElement).dataset.sprClipboard).toBe(
      `${location.origin}/-/hooks/gh`,
    );
    expect(full.querySelector('code')?.textContent).toBe('https://docs.acme.example/-/hooks/other');
  });

  it('shows a rectangle to drop into while a file is dragged, and clears a picked file back to the box', () => {
    document.body.innerHTML = `
      <main>
        <form class="spr-config" method="post" action="/-/config/sources/gh" data-spr-config="sources/gh">
          <div class="spr-field" data-spr-drop-zone>
            <span class="spr-pickable">
              <input type="password" name="forges.gh.private_key" id="f-forges.gh.private_key">
              <span class="spr-pickable-chip">
                <span class="spr-pickable-name" data-spr-picked hidden></span>
                <button type="button" data-spr-unpick></button>
              </span>
              <input type="file" class="spr-file spr-file-tucked" name="file:forges.gh.private_key">
            </span>
            <span class="spr-drop" aria-hidden="true">Drop the App’s .pem file here</span>
          </div>
          <div class="spr-config-actions">
            <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
          </div>
        </form>
      </main>`;
    run();

    const zone = form().querySelector('[data-spr-drop-zone]') as HTMLElement;
    const drag = (kind: string, target: Element, types: string[]): void => {
      const event = new Event(kind, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { types, files: [] } });
      target.dispatchEvent(event);
    };

    // Dragged text is not a file, so no rectangle appears for it
    drag('dragenter', document.body, ['text/plain']);
    expect(zone.hasAttribute('data-spr-dragging')).toBe(false);

    drag('dragenter', document.body, ['Files']);
    expect(zone.hasAttribute('data-spr-dragging')).toBe(true);
    expect(zone.hasAttribute('data-spr-drop-over')).toBe(false);

    drag('dragenter', zone, ['Files']);
    expect(zone.hasAttribute('data-spr-drop-over')).toBe(true);

    // Leaving the field but not the page keeps the rectangle; leaving the page hides it
    drag('dragleave', zone, ['Files']);
    expect(zone.hasAttribute('data-spr-dragging')).toBe(true);
    drag('dragleave', document.body, ['Files']);
    expect(zone.hasAttribute('data-spr-dragging')).toBe(false);

    const picker = form().querySelector('input[type="file"]') as HTMLInputElement;
    const picked = form().querySelector('[data-spr-picked]') as HTMLElement;
    Object.defineProperty(picker, 'files', {
      value: [{ name: 'app.pem', size: 1700 }],
      configurable: true,
    });
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    expect(picked.textContent).toBe('app.pem');
    expect(picked.hidden).toBe(false);

    Object.defineProperty(picker, 'files', { value: [], configurable: true });
    (form().querySelector('[data-spr-unpick]') as HTMLButtonElement).click();
    expect(picked.hidden).toBe(true);
    expect(document.activeElement).toBe(form().querySelector('input[type="password"]'));
  });

  it('leaves an ordinary control to the check, and submits nothing', async () => {
    const submitted: unknown[] = [];
    renderReshaping();
    run();
    form().addEventListener('submit', (event) => {
      event.preventDefault();
      submitted.push(event);
    });

    type('assets.path', '/srv/assets');
    await settle();

    expect(submitted).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stays shut on a page with nothing to save, and asks the server nothing', async () => {
    render();
    run();
    await settle();
    expect(pending()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens when something is typed, and shuts again when it is typed back', async () => {
    render();
    run();

    type('brand.name', 'Docs and more');
    expect(pending()).toBe(true);

    type('brand.name', 'Docs');
    expect(pending()).toBe(false);
    expect(status()?.textContent).toBe('');
  });

  it('ignores the name of an entry that does not exist yet', () => {
    render();
    run();
    type('newname:auth.providers', 'okta');
    expect(pending()).toBe(false);
  });

  it('stays open on work the server says is unsaved, whatever the controls say', () => {
    render(true);
    run();
    expect(pending()).toBe(true);

    type('brand.name', 'Something else');
    type('brand.name', 'Docs');
    expect(pending()).toBe(true);
  });

  it('checks against the server, carrying the intent and no operation', async () => {
    render();
    run();
    type('brand.name', 'Docs and more');
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/-/config/branding');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');

    const body = init.body as FormData;
    expect(body.get('intent')).toBe('check');
    expect(body.get('op')).toBeNull();
  });

  it('waits for the typing to stop rather than checking per keystroke', async () => {
    render();
    run();

    type('brand.name', 'D');
    jest.advanceTimersByTime(100);
    type('brand.name', 'Do');
    jest.advanceTimersByTime(100);
    type('brand.name', 'Doc');
    expect(fetchMock).not.toHaveBeenCalled();

    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('says nothing about a check that answers quickly', async () => {
    render();
    run();
    type('brand.name', 'Docs and more');

    const seen: (string | null)[] = [];
    const observer = new MutationObserver(() => seen.push(status()?.textContent ?? null));
    observer.observe(status() as Node, { childList: true, characterData: true, subtree: true });

    await settle();
    observer.disconnect();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen).not.toContain('Checking…');
    expect(status()?.textContent).toBe('Unsaved changes.');
  });

  it('says so once a check has been going long enough to wonder about', async () => {
    const held = deferredFetch();
    render();
    run();
    type('brand.name', 'Docs and more');

    jest.advanceTimersByTime(DEBOUNCE_MS);
    await flush();
    expect(status()?.textContent).toBe('Unsaved changes.');

    jest.advanceTimersByTime(SLOW_CHECK_MS);
    expect(status()?.textContent).toBe('Checking…');

    held.resolve({
      ok: true,
      json: async () => ({
        error: null,
        verdict: { changed: [], rebuild: false, effect: 'hot', hotReloadAvailable: true },
      }),
    });
    await flush();
    expect(status()?.textContent).toBe('Unsaved changes.');
  });

  it('does not shrink the sentence back on the next keystroke', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        error: null,
        verdict: {
          changed: [{ key: 'assets', requiresRestart: true }],
          rebuild: false,
          effect: 'restart',
          hotReloadAvailable: true,
        },
      }),
    });
    render();
    run();
    type('brand.name', 'Docs and more');
    await settle();
    expect(status()?.textContent).toContain('Takes effect on restart');

    type('brand.name', 'Docs and more still');
    expect(status()?.textContent).toContain('Takes effect on restart');
  });

  it('disables Save while the loader is refusing the document, once Save has been pressed', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'schema validation failed: issuer is required', verdict: null }),
    });
    render();
    run();
    type('brand.name', 'Docs and more');
    await settle();

    // Held back until the operator asks to save
    expect(save().disabled).toBe(false);
    expect(status()?.textContent).toBe('Unsaved changes.');

    expect(pressSave()).toBe(false);
    expect(save().disabled).toBe(true);
    expect(status()?.textContent).toContain('schema validation failed');
    expect(form().getAttribute('data-spr-check')).toBe('invalid');
  });

  it('says which field the loader refused, not only that it refused', async () => {
    render();
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({
        error: 'instance config failed schema validation',
        problems: [
          'auth.providers.link.token_ttl: must match pattern "^[0-9]+(s|m|h|d)$"',
          'auth.providers.link.session_ttl: must match pattern "^[0-9]+(s|m|h|d)$"',
        ],
        verdict: null,
      }),
    });
    run();

    type('brand.name', 'Handbook');
    await settle();
    pressSave();

    expect(status()?.textContent).toBe(
      'instance config failed schema validation: auth.providers.link.token_ttl: must match pattern "^[0-9]+(s|m|h|d)$"',
    );
    expect(status()?.textContent).not.toContain('`');
    expect(status()?.textContent).not.toContain('session_ttl');
  });

  it('says a problem carrying a link as the words it is made of', async () => {
    render();
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({
        error: 'instance config is not internally consistent',
        problems: [
          'a magic-link provider needs the mail transport, and this configuration has no ' +
            '`mail` block. Configure it under [Mail transport](/-/config/mail), then ' +
            'add the provider.',
        ],
        verdict: null,
      }),
    });
    run();

    type('brand.name', 'Handbook');
    await settle();
    pressSave();

    expect(status()?.textContent).toContain('Configure it under Mail transport, then');
    expect(status()?.textContent).not.toContain('/-/config/mail');
    expect(status()?.textContent).not.toContain('[');
  });

  it('offers Save again once the document loads, and says what saving costs', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'schema validation failed', verdict: null }),
    });
    render();
    run();
    type('brand.name', '');
    await settle();
    pressSave();
    expect(save().disabled).toBe(true);

    type('brand.name', 'Docs and more');
    await settle();
    expect(save().disabled).toBe(false);
    expect(status()?.textContent).toBe('Unsaved changes.');
  });

  it('warns about a rebuild before the button is pressed, not after', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        error: null,
        verdict: {
          changed: [{ key: 'groups', requiresRestart: false }],
          rebuild: true,
          effect: 'rebuild',
          hotReloadAvailable: true,
        },
      }),
    });
    render();
    run();
    type('brand.name', 'Docs and more');
    await settle();

    expect(status()?.textContent).toContain('full rebuild');
  });

  it('says a restart is needed without listing what builds at startup', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        error: null,
        verdict: {
          changed: [
            { key: 'assets', requiresRestart: true },
            { key: 'brand', requiresRestart: false },
          ],
          rebuild: false,
          effect: 'restart',
          hotReloadAvailable: true,
        },
      }),
    });
    render();
    run();
    type('brand.name', 'Docs and more');
    await settle();

    expect(status()?.textContent).toContain('Takes effect on restart');
    expect(status()?.textContent).not.toContain('assets');
  });

  it('leaves Save live when the check cannot be made at all', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    render();
    run();
    type('brand.name', 'Docs and more');
    await settle();

    expect(save().disabled).toBe(false);
    expect(status()?.textContent).toContain('Save will');
  });

  it('does not scold a page nobody has touched, and leaves Save live on it', async () => {
    renderDraft();
    run();
    await settle();

    expect(status()?.textContent).toBe('Unsaved changes.');
    expect(save().disabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says what is wrong once Save is pressed, in the two cases that differ', async () => {
    renderDraft();
    run();

    type('auth.providers.test.issuer', '!!');
    await settle();
    expect(status()?.textContent).toBe('Unsaved changes.');
    expect(save().disabled).toBe(false);

    expect(pressSave()).toBe(false);
    expect(save().disabled).toBe(true);
    expect(status()?.textContent).toBe(
      'Unsaved changes. Something here is not in a shape its control accepts.',
    );

    type('auth.providers.test.issuer', '');
    await settle();
    expect(status()?.textContent).toBe(
      'Unsaved changes. Something here still has to be filled in.',
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens a page reached by Add without an error, and shows it only when Save is pressed', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'instance config failed schema validation', verdict: null }),
    });
    render(true);
    run();
    await settle();

    // Checked on arrival, and nothing said of it yet
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(status()?.textContent).toBe('Unsaved changes.');
    expect(save().disabled).toBe(false);

    expect(pressSave()).toBe(false);
    expect(status()?.textContent).toBe('instance config failed schema validation');
    expect(save().disabled).toBe(true);

    // From here on the check answers live, and a fix takes the error away
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        error: null,
        verdict: { changed: [], rebuild: false, effect: 'hot', hotReloadAvailable: true },
      }),
    });
    type('brand.name', 'Fixed');
    await settle();
    expect(status()?.textContent).toBe('Unsaved changes.');
    expect(save().disabled).toBe(false);
  });

  it('lets Save through when nothing was found wrong', async () => {
    render();
    run();
    type('brand.name', 'Docs and more');
    await settle();

    expect(pressSave()).toBe(true);
  });

  it('shows problems straight away on a page that came back from a refused save', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'instance config failed schema validation', verdict: null }),
    });
    render(true);
    form().setAttribute('data-spr-attempted', '');
    run();
    await settle();

    expect(status()?.textContent).toBe('instance config failed schema validation');
    expect(save().disabled).toBe(true);
  });

  it('checks with the server as soon as the controls are satisfied', async () => {
    renderDraft();
    run();
    type('auth.providers.test.issuer', 'a-tenant');
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(save().disabled).toBe(false);
  });

  it('closes a modal on Escape and puts focus back where it came from', () => {
    render();
    const head = document.createElement('div');
    head.innerHTML = `
      <details class="spr-modal">
        <summary>Rename</summary>
        <div class="spr-modal-panel"><input name="rename" value="entra"></div>
      </details>`;
    document.body.append(head);
    run();

    const modal = document.querySelector('details.spr-modal') as HTMLDetailsElement;
    modal.open = true;
    modal.dispatchEvent(new Event('toggle'));
    expect(document.activeElement).toBe(modal.querySelector('input'));

    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal.open).toBe(false);
    expect(document.activeElement).toBe(modal.querySelector('summary'));
  });

  it('leaves a page with no modal alone, and takes Escape from nobody', () => {
    render();
    run();
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('details.spr-modal')).toBeNull();
  });

  it('fills the name in from the kind, and stops the moment somebody disagrees', () => {
    render();
    const add = document.createElement('div');
    add.innerHTML = `
      <fieldset class="spr-choices" data-spr-suggests="add-name">
        <details class="spr-dropdown">
          <summary></summary>
          <div class="spr-dd-list">
            <label class="spr-dd-row"><input class="spr-clipped" type="radio" name="kind" value="entra" data-spr-suggest="entra-2" checked><span>Microsoft Entra ID</span></label>
            <label class="spr-dd-row"><input class="spr-clipped" type="radio" name="kind" value="github" data-spr-suggest="github"><span>GitHub</span></label>
          </div>
        </details>
      </fieldset>
      <input id="add-name" name="add" value="entra-2">`;
    document.body.append(add);
    run();

    const radios = add.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const [entra, github] = [radios[0], radios[1]];
    const name = document.getElementById('add-name') as HTMLInputElement;

    github.checked = true;
    github.dispatchEvent(new Event('change', { bubbles: true }));
    expect(name.value).toBe('github');

    name.value = 'work-github';
    entra.checked = true;
    entra.dispatchEvent(new Event('change', { bubbles: true }));
    expect(name.value).toBe('work-github');
  });

  it('walks into the list from the summary, so an open list answers the arrows', () => {
    render();
    const add = document.createElement('div');
    add.innerHTML = `
      <details class="spr-dropdown" open>
        <summary></summary>
        <div class="spr-dd-list" tabindex="-1">
          <label class="spr-dd-row"><input class="spr-clipped" type="radio" name="k" value="entra"><span>Entra</span></label>
          <label class="spr-dd-row"><input class="spr-clipped" type="radio" name="k" value="github" checked><span>GitHub</span></label>
        </div>
      </details>`;
    document.body.append(add);
    run();

    const dropdown = add.querySelector('details') as HTMLDetailsElement;
    const summary = dropdown.querySelector('summary') as HTMLElement;
    const [entra, github] = Array.from(add.querySelectorAll<HTMLInputElement>('input'));

    summary.focus();
    summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(github);
    expect(entra.checked).toBe(false);
    expect(dropdown.open).toBe(true);
  });

  it('shuts a dropdown on the pick, on Escape and on a click away — not while the arrows walk it', () => {
    render();
    const add = document.createElement('div');
    add.innerHTML = `
      <details class="spr-dropdown" open>
        <summary></summary>
        <div class="spr-dd-list" tabindex="-1">
          <label class="spr-dd-row"><input class="spr-clipped" type="radio" name="kind" value="entra" checked><span>Microsoft Entra ID</span></label>
          <label class="spr-dd-row"><input class="spr-clipped" type="radio" name="kind" value="github"><span>GitHub</span></label>
        </div>
      </details>`;
    document.body.append(add);
    run();

    const dropdown = add.querySelector('details') as HTMLDetailsElement;
    const github = add.querySelectorAll<HTMLInputElement>('input')[1];

    github.checked = true;
    github.dispatchEvent(new Event('change', { bubbles: true }));
    github.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(dropdown.open).toBe(true);

    github.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    expect(dropdown.open).toBe(false);

    dropdown.open = true;
    github.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(dropdown.open).toBe(false);
    expect(document.activeElement).toBe(dropdown.querySelector('summary'));

    dropdown.open = true;
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dropdown.open).toBe(false);

    dropdown.open = true;
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dropdown.open).toBe(false);
  });

  it('disables the button while the chosen answer is one that needs another page', () => {
    render();
    const add = document.createElement('div');
    add.innerHTML = `
      <div class="spr-modal-panel">
        <fieldset class="spr-choices">
          <details class="spr-dropdown">
            <div class="spr-dd-list">
              <label class="spr-dd-row"><input class="spr-clipped" type="radio" name="kind" value="entra" checked><span>Microsoft Entra ID</span></label>
              <label class="spr-dd-row"><input class="spr-clipped" type="radio" name="kind" value="magic-link" data-spr-unavailable><span>Magic link (email)</span></label>
            </div>
          </details>
          <p class="spr-help spr-choice-note">Configure it under Mail transport.</p>
        </fieldset>
        <div class="spr-modal-actions">
          <button type="submit" form="add-member">Add a provider</button>
        </div>
      </div>`;
    document.body.append(add);
    run();

    const radios = add.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const [entra, magic] = [radios[0], radios[1]];
    const button = add.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    magic.checked = true;
    entra.checked = false;
    magic.dispatchEvent(new Event('change', { bubbles: true }));
    expect(button.disabled).toBe(true);

    entra.checked = true;
    magic.checked = false;
    entra.dispatchEvent(new Event('change', { bubbles: true }));
    expect(button.disabled).toBe(false);
  });

  it('settles the button on arrival, not only on a change', () => {
    render();
    const add = document.createElement('div');
    add.innerHTML = `
      <div class="spr-modal-panel">
        <fieldset class="spr-choices">
          <label class="spr-dd-row"><input type="radio" name="kind" value="magic-link" data-spr-unavailable checked><span>Magic link (email)</span></label>
        </fieldset>
        <div class="spr-modal-actions"><button type="submit" form="add-member">Add a provider</button></div>
      </div>`;
    document.body.append(add);
    run();

    expect((add.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('leaves a choice group that needs nothing alone', () => {
    render();
    const add = document.createElement('div');
    add.innerHTML = `
      <div class="spr-modal-panel">
        <fieldset class="spr-choices">
          <label class="spr-dd-row"><input type="radio" name="kind" value="entra" checked><span>Microsoft Entra ID</span></label>
        </fieldset>
        <div class="spr-modal-actions"><button type="submit" form="add-member">Add a provider</button></div>
      </div>`;
    document.body.append(add);
    run();

    const button = add.querySelector('button') as HTMLButtonElement;
    const radio = add.querySelector('input') as HTMLInputElement;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    expect(button.disabled).toBe(false);
  });

  it('leaves a page with no dropdown alone', () => {
    render();
    run();
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('details.spr-dropdown')).toBeNull();
  });

  it('does nothing at all on a page with no form to watch', () => {
    document.body.innerHTML = '<main><h1>Configuration</h1></main>';
    expect(run).not.toThrow();
  });

  it('does nothing in file mode, where the form renders no actions', () => {
    document.body.innerHTML = `
      <main>
        <form class="spr-config" data-spr-config="branding">
          <input name="brand.name" value="Docs" disabled>
        </form>
      </main>`;
    run();
    expect(form().hasAttribute('data-spr-live')).toBe(false);
  });
});

describe('the colour swatch', () => {
  function renderColours(value = '#2f5d8a', placeholder = ''): HTMLFormElement {
    document.body.innerHTML = `
      <main>
        <form class="spr-config" method="post" action="/-/config/branding/appearance"
              data-spr-config="branding/appearance">
          <div class="spr-field spr-field-color">
            <span class="spr-swatch">
              <input type="color" data-spr-swatch-for="theme.palette.light.accent" hidden
                     aria-hidden="true" tabindex="-1">
              <input name="theme.palette.light.accent" type="text" value="${value}"
                     placeholder="${placeholder}">
            </span>
          </div>
          <div class="spr-config-actions">
            <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
          </div>
        </form>
      </main>`;
    return document.querySelector('form') as HTMLFormElement;
  }

  const swatch = () => document.querySelector('input[type="color"]') as HTMLInputElement;
  const box = () => document.querySelector('input[type="text"]') as HTMLInputElement;

  it('is offered only where there is script to wire it to', () => {
    renderColours();
    expect(swatch().hidden).toBe(true);
    run();
    expect(swatch().hidden).toBe(false);
  });

  it('starts on the value the box holds, rather than on black', () => {
    renderColours('#8a4b2f');
    run();
    expect(swatch().value).toBe('#8a4b2f');
  });

  it('widens a three-digit colour on the way in, and only on the way in', () => {
    renderColours('#f0a');
    run();
    expect(swatch().value).toBe('#ff00aa');
    expect(box().value).toBe('#f0a');
  });

  it('leaves the swatch alone while the box holds something that is not a colour', () => {
    renderColours('#2f5d8a');
    run();
    box().value = '#2f5d8';
    box().dispatchEvent(new Event('input', { bubbles: true }));
    expect(swatch().value).toBe('#2f5d8a');
  });

  it('writes what was picked into the box, and tells the bar it did', () => {
    const form = renderColours('#2f5d8a');
    run();

    let heard = 0;
    form.addEventListener('input', () => {
      heard += 1;
    });

    swatch().value = '#123456';
    swatch().dispatchEvent(new Event('input', { bubbles: true }));

    expect(box().value).toBe('#123456');
    expect(heard).toBeGreaterThan(0);
  });

  it('opens on the template\u2019s own colour where the box is empty', () => {
    renderColours('', '#f0a');
    run();
    expect(swatch().value).toBe('#ff00aa');
    expect(box().value).toBe('');
  });

  it('goes back to the placeholder when a colour is cleared', () => {
    renderColours('#123456', '#2f5d8a');
    run();
    expect(swatch().value).toBe('#123456');

    box().value = '';
    box().dispatchEvent(new Event('input', { bubbles: true }));
    expect(swatch().value).toBe('#2f5d8a');
  });

  it('submits nothing of its own', () => {
    renderColours();
    run();
    expect(swatch().getAttribute('name')).toBeNull();
  });
});

describe('a block that is shown with an answer', () => {
  function renderProvider(secret = '${A_SECRET}', picked = ''): HTMLFormElement {
    const stored = secret === '';
    document.body.innerHTML = `
      <main>
        <form class="spr-config" method="post" action="/-/config/identity/entra"
              data-spr-config="identity/entra">
          <input name="auth.providers.entra.issuer" value="a-tenant-guid">
          <input name="auth.providers.entra.client_id" value="a-client-id">
          <input name="auth.providers.entra.client_secret" value="${secret}">
          <div class="spr-field spr-field-select">
            <select name="auth.providers.entra.directory.type">
              <option value="" ${picked === '' ? 'selected' : ''}>Not configured</option>
              <option value="graph" ${picked === 'graph' ? 'selected' : ''}>Microsoft Graph</option>
            </select>
          </div>
          <div class="spr-field spr-field-text"
               data-spr-shown-with="auth.providers.entra.directory.type"
               data-spr-copy-from="auth.providers.entra.client_id">
            <input name="auth.providers.entra.directory.client_id" value="">
            <button type="button" data-spr-copy="auth.providers.entra.directory.client_id" hidden>Copy from the sign-in app</button>
          </div>
          <div class="spr-field spr-field-secret"
               data-spr-shown-with="auth.providers.entra.directory.type"
               data-spr-copy-from="auth.providers.entra.client_secret">
            <input name="auth.providers.entra.directory.client_secret" value="">
            <button type="button" data-spr-copy="auth.providers.entra.directory.client_secret" hidden>Copy from the sign-in app</button>
            ${stored ? '<input type="checkbox" name="copy:auth.providers.entra.directory.client_secret" value="on" data-spr-copy-stored hidden>' : ''}
            ${stored ? '<p class="spr-help" data-spr-copy-note hidden>Copied from the sign-in app when you save.</p>' : ''}
          </div>
          <div class="spr-config-actions">
            <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
          </div>
        </form>
      </main>`;
    return document.querySelector('form') as HTMLFormElement;
  }

  const fields = () => Array.from(document.querySelectorAll<HTMLElement>('[data-spr-shown-with]'));
  const copy = (key = 'client_id') =>
    document.querySelector(
      `button[data-spr-copy="auth.providers.entra.directory.${key}"]`,
    ) as HTMLButtonElement;
  const box = (name: string) => document.querySelector(`input[name="${name}"]`) as HTMLInputElement;

  it('folds the block away while the answer is "not configured"', () => {
    renderProvider();
    run();
    expect(fields().every((field) => field.hidden)).toBe(true);
    expect(box('auth.providers.entra.directory.client_id').disabled).toBe(false);
  });

  it('opens it the moment the kind is picked, without a save', () => {
    const form = renderProvider();
    run();
    const select = form.querySelector('select') as HTMLSelectElement;
    select.value = 'graph';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(fields().some((field) => field.hidden)).toBe(false);
  });

  it('shows the block a page arrives with already answered', () => {
    renderProvider('${A_SECRET}', 'graph');
    run();
    expect(fields().some((field) => field.hidden)).toBe(false);
  });

  it('offers a copy under each box it fills, and none without script', () => {
    renderProvider('${A_SECRET}', 'graph');
    expect(copy('client_id').hidden).toBe(true);
    expect(copy('client_secret').hidden).toBe(true);

    run();
    expect(copy('client_id').hidden).toBe(false);
    expect(copy('client_secret').hidden).toBe(false);
  });

  it('copies what is on the page, and tells the bar it did', () => {
    const form = renderProvider('${A_SECRET}', 'graph');
    run();
    expect(form.hasAttribute('data-spr-pending')).toBe(false);

    copy('client_id').click();
    copy('client_secret').click();

    expect(box('auth.providers.entra.directory.client_id').value).toBe('a-client-id');
    expect(box('auth.providers.entra.directory.client_secret').value).toBe('${A_SECRET}');
    expect(form.hasAttribute('data-spr-pending')).toBe(true);
  });

  it('hands a stored secret to the save instead, and says which one happened', () => {
    const form = renderProvider('', 'graph');
    run();
    copy('client_secret').click();

    const stored = form.querySelector('[data-spr-copy-stored]') as HTMLInputElement;
    expect(stored.checked).toBe(true);
    expect(box('auth.providers.entra.directory.client_secret').value).toBe('');
    expect((form.querySelector('[data-spr-copy-note]') as HTMLElement).hidden).toBe(false);
    expect(form.hasAttribute('data-spr-pending')).toBe(true);
  });

  it('leaves a typed box alone when there is nothing on the page to take', () => {
    renderProvider('', 'graph');
    run();
    box('auth.providers.entra.directory.client_secret').value = 'typed-by-hand';
    copy('client_secret').click();

    expect(box('auth.providers.entra.directory.client_secret').value).toBe('typed-by-hand');
  });

  it('leaves a page with no such block alone', () => {
    render();
    expect(run).not.toThrow();
  });
});

describe('switches shown with the switch above them', () => {
  function renderAnalytics(enabled = false): HTMLFormElement {
    document.body.innerHTML = `
      <main>
        <form class="spr-config" method="post" action="/-/config/analytics"
              data-spr-config="analytics">
          <div class="spr-field spr-field-boolean">
            <label class="spr-switch">
              <input type="checkbox" name="analytics.enabled" value="on" ${enabled ? 'checked' : ''}>
              <span>Count total reads</span>
            </label>
          </div>
          <div class="spr-field spr-field-boolean" data-spr-shown-with="analytics.enabled">
            <label class="spr-switch">
              <input type="checkbox" name="analytics.unique_readers" value="on" checked>
              <span>Count unique readers</span>
            </label>
          </div>
          <div class="spr-field spr-field-boolean" data-spr-shown-with="analytics.enabled">
            <label class="spr-switch">
              <input type="checkbox" name="analytics.public_beacon" value="on" checked>
              <span>Count public pages in the browser</span>
            </label>
          </div>
          <div class="spr-config-actions">
            <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
          </div>
        </form>
      </main>`;
    return document.querySelector('form') as HTMLFormElement;
  }

  const dependents = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-spr-shown-with="analytics.enabled"]'));
  const master = () =>
    document.querySelector('input[name="analytics.enabled"]') as HTMLInputElement;

  it('folds them away while the switch above them is off', () => {
    renderAnalytics(false);
    run();
    expect(dependents().every((field) => field.hidden)).toBe(true);
  });

  it('shows them on a page that arrives with it on', () => {
    renderAnalytics(true);
    run();
    expect(dependents().some((field) => field.hidden)).toBe(false);
  });

  it('opens and closes them as the switch moves, without a save', () => {
    renderAnalytics(false);
    run();
    master().checked = true;
    master().dispatchEvent(new Event('change', { bubbles: true }));
    expect(dependents().some((field) => field.hidden)).toBe(false);

    master().checked = false;
    master().dispatchEvent(new Event('change', { bubbles: true }));
    expect(dependents().every((field) => field.hidden)).toBe(true);
  });

  it('hides and never disables, so the document is unchanged either way', () => {
    renderAnalytics(false);
    run();
    const submitted = new FormData(document.querySelector('form') as HTMLFormElement);
    expect(submitted.get('analytics.unique_readers')).toBe('on');
    expect(submitted.get('analytics.public_beacon')).toBe('on');
  });
});

describe('a card shown with the switch above it', () => {
  function renderReading(enabled = false): HTMLFormElement {
    document.body.innerHTML = `
      <main>
        <form class="spr-config" method="post" action="/-/config/reading"
              data-spr-config="reading">
          <div class="spr-field spr-field-boolean">
            <label class="spr-switch">
              <input type="checkbox" name="graph.enabled" value="on" ${enabled ? 'checked' : ''}>
              <span>Link graph</span>
            </label>
          </div>
          <section class="spr-card spr-card-1" data-spr-shown-with="graph.enabled">
            <header><h4>Related column</h4></header>
            <div class="spr-fields">
              <div class="spr-field spr-field-boolean">
                <label class="spr-switch">
                  <input type="checkbox" name="graph.related" value="on" checked>
                  <span>Related column</span>
                </label>
              </div>
              <div class="spr-field spr-field-number" data-spr-shown-with="graph.related">
                <label>Related entries shown</label>
                <input type="number" name="graph.related_limit" value="10">
              </div>
            </div>
          </section>
          <div class="spr-config-actions">
            <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
          </div>
        </form>
      </main>`;
    return document.querySelector('form') as HTMLFormElement;
  }

  const card = () => document.querySelector('section.spr-card') as HTMLElement;
  const limit = () =>
    document.querySelector('[data-spr-shown-with="graph.related"]') as HTMLElement;
  const master = () => document.querySelector('input[name="graph.enabled"]') as HTMLInputElement;

  it('folds the card away while the graph is off', () => {
    renderReading(false);
    run();
    expect(card().hidden).toBe(true);
  });

  it('shows it on a page that arrives with the graph on', () => {
    renderReading(true);
    run();
    expect(card().hidden).toBe(false);
    expect(limit().hidden).toBe(false);
  });

  it('opens and closes it as the switch moves, without a save', () => {
    renderReading(false);
    run();
    master().checked = true;
    master().dispatchEvent(new Event('change', { bubbles: true }));
    expect(card().hidden).toBe(false);

    master().checked = false;
    master().dispatchEvent(new Event('change', { bubbles: true }));
    expect(card().hidden).toBe(true);
  });

  it('keeps every control inside submitting, so the document is unchanged', () => {
    renderReading(false);
    run();
    const submitted = new FormData(document.querySelector('form') as HTMLFormElement);
    expect(submitted.get('graph.related')).toBe('on');
    expect(submitted.get('graph.related_limit')).toBe('10');
  });
});

function renderIndex(query = ''): void {
  document.body.innerHTML = `
    <main>
      <form class="spr-form spr-filter" method="get" action="/-/config/groups" data-spr-filter>
        <input id="filter-groups" type="search" name="q" value="${query}" aria-label="Find groups">
        <button type="submit" class="spr-filter-go">Filter</button>
      </form>
      <div class="spr-scroll">
        <table class="spr-table spr-entries">
          <tbody>
            <tr data-spr-row="engineering entra (grp-eng)"><th><a href="#">engineering</a></th></tr>
            <tr data-spr-row="client-northwind entra (grp-northwind)"><th><a href="#">client-northwind</a></th></tr>
          </tbody>
        </table>
      </div>
      <p class="spr-note spr-note-idle" data-spr-empty="none" hidden>This instance has no groups yet.</p>
      <p class="spr-note spr-note-idle" data-spr-empty="filtered" hidden>Nothing here matches <code data-spr-needle>${query}</code>.</p>
      <form class="spr-config" method="post" action="/-/config/groups" data-spr-config="groups">
        <input type="hidden" name="__shape:groups" value="engineering,client-northwind">
        <div class="spr-config-actions">
          <button type="submit" name="intent" value="check" class="spr-config-check">Check changes</button>
          <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
        </div>
      </form>
    </main>`;
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('tr[data-spr-row]'));
const shown = () =>
  rows()
    .filter((row) => !row.hidden)
    .map((row) => row.dataset.sprRow?.split(' ')[0]);
const box = () => document.querySelector('input[name="q"]') as HTMLInputElement;
const emptyNone = () => document.querySelector('[data-spr-empty="none"]') as HTMLElement;
const emptyFiltered = () => document.querySelector('[data-spr-empty="filtered"]') as HTMLElement;

function filter(value: string): void {
  box().value = value;
  box().dispatchEvent(new Event('input', { bubbles: true }));
}

describe('the transport of a git remote', () => {
  const URL_PATH = 'forges.onprem.repos.0.url';

  function renderChoice(): HTMLFormElement {
    document.body.innerHTML = `
      <main>
        <form class="spr-config" method="post" action="/-/config/sources/onprem"
              data-spr-config="sources/onprem">
          <div class="spr-choice" data-spr-choice="${URL_PATH}">
            <div class="spr-choice-switch" role="radiogroup" aria-label="Transport">
              <label>
                <input type="radio" name="choice:${URL_PATH}" value="https" checked
                       data-spr-choice-prefix="https://"
                       data-spr-choice-placeholder="https://example.com/team/docs.git"
                       data-spr-choice-hint="With HTTPS selected, the remote URL starts with https://.">
                HTTPS
              </label>
              <label>
                <input type="radio" name="choice:${URL_PATH}" value="ssh"
                       data-spr-choice-prefix="ssh://"
                       data-spr-choice-placeholder="ssh://git@example.com/team/docs.git"
                       data-spr-choice-hint="With SSH selected, the remote URL starts with ssh://.">
                SSH
              </label>
            </div>
            <div class="spr-fields">
              <div class="spr-field spr-field-text">
                <input name="${URL_PATH}" value="">
              </div>
            </div>
          </div>
          <div class="spr-config-actions">
            <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
          </div>
        </form>
      </main>`;
    return document.querySelector('form') as HTMLFormElement;
  }

  const url = () => document.querySelector(`input[name="${URL_PATH}"]`) as HTMLInputElement;
  const radio = (value: string) =>
    document.querySelector(`input[type="radio"][value="${value}"]`) as HTMLInputElement;

  it('fits the URL to the checked option', () => {
    renderChoice();
    run();
    expect(url().placeholder).toBe('https://example.com/team/docs.git');
    expect(url().pattern).toBe('https://.*');
    expect(url().title).toBe('With HTTPS selected, the remote URL starts with https://.');
  });

  it('checks SSH when an ssh:// URL is typed', () => {
    renderChoice();
    run();
    type(URL_PATH, 'ssh://git@example.test/internal/runbooks.git');
    expect(radio('ssh').checked).toBe(true);
    expect(radio('https').checked).toBe(false);
    expect(url().pattern).toBe('ssh://.*');
  });

  it('fits the URL again when the other option is picked by hand', () => {
    renderChoice();
    run();
    radio('ssh').checked = true;
    radio('ssh').dispatchEvent(new Event('change', { bubbles: true }));
    expect(url().placeholder).toBe('ssh://git@example.com/team/docs.git');
    expect(url().pattern).toBe('ssh://.*');
  });
});

describe('a table that grows', () => {
  function renderTable(): HTMLFormElement {
    document.body.innerHTML = `
      <main>
        <form class="spr-config" method="post" action="/-/config/groups/eng/entra"
              data-spr-config="groups/eng/entra">
          <input type="hidden" name="__shape:groups.eng" value="group">
          <table class="spr-table spr-rows" data-spr-grow="groups.eng" data-spr-kind="group">
            <tbody>
              <tr data-spr-position="0">
                <td><input type="checkbox" name="select" value="remove:groups.eng.0"></td>
                <td><input type="text" name="groups.eng.0.id" value="grp-eng"></td>
              </tr>
              <tr data-spr-position="1" data-spr-trailing>
                <td></td>
                <td><input type="text" name="groups.eng.1.id" value=""></td>
              </tr>
            </tbody>
          </table>
          <table class="spr-table spr-rows" data-spr-grow="groups.eng" data-spr-kind="person">
            <tbody>
              <tr data-spr-position="2" data-spr-trailing>
                <td></td>
                <td><input type="text" name="groups.eng.2.email" value=""></td>
                <td><input type="text" name="groups.eng.2.note" value=""></td>
              </tr>
            </tbody>
          </table>
          <button type="submit" name="op" value="remove-selected:groups.eng"
                  class="spr-remove spr-bulk-remove">Remove selected</button>
          <div class="spr-config-actions">
            <button type="submit" name="intent" value="check" class="spr-config-check">Check</button>
            <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
          </div>
        </form>
      </main>`;
    return document.querySelector('form') as HTMLFormElement;
  }

  const rows = (kind: string): HTMLTableRowElement[] =>
    Array.from(
      document.querySelectorAll<HTMLTableRowElement>(`table[data-spr-kind="${kind}"] tbody tr`),
    );
  const shape = (): string =>
    (document.querySelector('input[name="__shape:groups.eng"]') as HTMLInputElement).value;

  beforeEach(() => {
    renderTable();
    run();
  });

  it('names the shape control the same string the server does', () => {
    const declared = (file: string): string | undefined => {
      const source = readFileSync(join(__dirname, '../..', file), 'utf8');
      return /SHAPE_PREFIX = '([^']*)'/.exec(source)?.[1];
    };
    const server = declared('src/dashboard/configurator/config-form/collections.ts');
    expect(server).toBeTruthy();
    expect(
      declared('src/global-ui/client-side-islands/configurator/growing-source-tables.ts'),
    ).toBe(server);
  });

  it('adds a row when the empty one is typed into', () => {
    expect(rows('group')).toHaveLength(2);
    type('groups.eng.1.id', 'grp-two');
    expect(rows('group')).toHaveLength(3);

    expect(rows('group')[1].hasAttribute('data-spr-trailing')).toBe(false);
    expect(rows('group')[2].hasAttribute('data-spr-trailing')).toBe(true);
  });

  it('numbers the unsaved rows in document order, across both tables', () => {
    type('groups.eng.1.id', 'grp-two');

    const fresh = rows('group')[2];
    expect(fresh.dataset.sprPosition).toBe('2');
    expect(fresh.querySelector('input[type="text"]')).toHaveProperty('name', 'groups.eng.2.id');
    expect(rows('person')[0].dataset.sprPosition).toBe('3');
    expect(rows('person')[0].querySelector('input[type="text"]')).toHaveProperty(
      'name',
      'groups.eng.3.email',
    );
  });

  it('extends the shape to cover the new position, kind by kind', () => {
    type('groups.eng.1.id', 'grp-two');
    expect(shape()).toBe('group,group,group,person');
  });

  it('leaves the shape alone until a row is actually added', () => {
    expect(shape()).toBe('group');
    type('groups.eng.0.id', 'edited');
    expect(shape()).toBe('group');
  });

  it('grows each table on its own, from the row that was typed in', () => {
    type('groups.eng.2.email', 'alice@example.test');
    expect(rows('person')).toHaveLength(2);
    expect(rows('group')).toHaveLength(2);
    expect(shape()).toBe('group,group,person,person');
  });

  it('adds one row per row, however much is typed into it', () => {
    type('groups.eng.1.id', 'g');
    type('groups.eng.1.id', 'gr');
    type('groups.eng.1.id', 'grp');
    expect(rows('group')).toHaveLength(3);
  });

  it('carries the cloned row’s hidden controls, renamed with it', () => {
    type('groups.eng.2.email', 'alice@example.test');
    const fresh = rows('person')[1];
    const boxes = Array.from(fresh.querySelectorAll<HTMLInputElement>('input[name]'));
    expect(boxes.map((box) => box.getAttribute('name'))).toEqual([
      'groups.eng.3.email',
      'groups.eng.3.note',
    ]);
    expect(boxes.every((box) => box.value === '')).toBe(true);
  });

  it('gives the row that was typed into a box, carrying no name', () => {
    type('groups.eng.1.id', 'grp-two');

    const typed = rows('group')[1].querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(typed).not.toBeNull();
    expect(typed?.hasAttribute('name')).toBe(false);
    expect(typed?.dataset.sprUnsaved).toBe('');

    const empty = rows('group')[2].querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(empty).not.toBeNull();
    expect(empty?.dataset.sprIdle).toBe('');
    expect(typed?.dataset.sprIdle).toBeUndefined();
  });

  it('holds the column open from the first paint, before anything is typed', () => {
    for (const row of Array.from(form().querySelectorAll('tr[data-spr-position]'))) {
      expect(row.querySelector('input[type="checkbox"]')).not.toBeNull();
    }
  });

  it('leaves a stored row’s box alone, which is a real one already', () => {
    const box = rows('group')[0].querySelector<HTMLInputElement>('input[name="select"]');
    expect(box).not.toBeNull();
    expect(box?.dataset.sprIdle).toBeUndefined();
    expect(box?.value).toBe('remove:groups.eng.0');
  });

  it('removes an unsaved row here, without asking the server', () => {
    type('groups.eng.1.id', 'grp-two');
    expect(rows('group')).toHaveLength(3);
    expect(shape()).toBe('group,group,group,person');

    (rows('group')[1].querySelector('input[data-spr-unsaved]') as HTMLInputElement).checked = true;
    const event = new Event('click', { bubbles: true, cancelable: true });
    form().querySelector<HTMLButtonElement>('.spr-bulk-remove')!.dispatchEvent(event);

    expect(rows('group')).toHaveLength(2);
    expect(shape()).toBe('group');
    expect(event.defaultPrevented).toBe(true);
  });

  it('closes the gap when the row above another unsaved one goes', () => {
    type('groups.eng.1.id', 'grp-two');
    type('groups.eng.2.id', 'grp-three');
    expect(rows('group')).toHaveLength(4);

    (rows('group')[1].querySelector('input[data-spr-unsaved]') as HTMLInputElement).checked = true;
    form()
      .querySelector<HTMLButtonElement>('.spr-bulk-remove')!
      .dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));

    const survivor = rows('group')[1];
    expect(survivor.dataset.sprPosition).toBe('1');
    const box = survivor.querySelector('input[type="text"]') as HTMLInputElement;
    expect(box.name).toBe('groups.eng.1.id');
    expect(box.value).toBe('grp-three');
    expect(shape()).toBe('group,group,group,person');
  });

  it('removes a stored row here too, and says so in the shape', () => {
    (rows('group')[0].querySelector('input[name="select"]') as HTMLInputElement).checked = true;

    const event = new Event('click', { bubbles: true, cancelable: true });
    form().querySelector<HTMLButtonElement>('.spr-bulk-remove')!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(rows('group')).toHaveLength(1);
    expect(shape()).toBe('group,person');
  });

  it('never submits the bulk button, even with nothing ticked', () => {
    const event = new Event('click', { bubbles: true, cancelable: true });
    form().querySelector<HTMLButtonElement>('.spr-bulk-remove')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(rows('group')).toHaveLength(2);
  });

  it('renumbers the survivors, ops and all', () => {
    const stored = rows('group')[0].cloneNode(true) as HTMLTableRowElement;
    stored.dataset.sprPosition = '1';
    (stored.querySelector('input[name="select"]') as HTMLInputElement).value =
      'remove:groups.eng.1';
    const text = stored.querySelector('input[type="text"]') as HTMLInputElement;
    text.name = 'groups.eng.1.id';
    text.value = 'grp-two';
    rows('group')[0].after(stored);

    (rows('group')[0].querySelector('input[name="select"]') as HTMLInputElement).checked = true;
    form()
      .querySelector<HTMLButtonElement>('.spr-bulk-remove')!
      .dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));

    const survivor = rows('group')[0];
    expect(survivor.dataset.sprPosition).toBe('0');
    expect((survivor.querySelector('input[type="text"]') as HTMLInputElement).name).toBe(
      'groups.eng.0.id',
    );
    expect((survivor.querySelector('input[name="select"]') as HTMLInputElement).value).toBe(
      'remove:groups.eng.0',
    );
  });
});

describe('a table that grows on part of a collection', () => {
  function renderPartial(): void {
    document.body.innerHTML = `
      <main>
        <form class="spr-config" method="post" action="/-/config/groups/eng/google"
              data-spr-config="groups/eng/google">
          <input type="hidden" name="__shape:groups.eng" value="group,group">
          <table class="spr-table spr-rows" data-spr-grow="groups.eng" data-spr-kind="group">
            <tbody>
              <tr data-spr-position="1">
                <td><input type="checkbox" name="select" value="remove:groups.eng.1"></td>
                <td><input type="text" name="groups.eng.1.id" value="grp-goo"></td>
                <td><input type="hidden" name="groups.eng.1.provider" value="google"></td>
              </tr>
              <tr data-spr-position="2" data-spr-trailing>
                <td></td>
                <td><input type="text" name="groups.eng.2.id" value=""></td>
              </tr>
            </tbody>
          </table>
          <table class="spr-table spr-rows" data-spr-grow="groups.eng" data-spr-kind="person">
            <tbody>
              <tr data-spr-position="3" data-spr-trailing>
                <td></td>
                <td><input type="text" name="groups.eng.3.email" value=""></td>
              </tr>
            </tbody>
          </table>
          <button type="submit" name="op" value="remove-selected:groups.eng"
                  class="spr-remove spr-bulk-remove">Remove selected</button>
          <div class="spr-config-actions">
            <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
          </div>
        </form>
      </main>`;
  }

  const rows = (kind: string): HTMLTableRowElement[] =>
    Array.from(
      document.querySelectorAll<HTMLTableRowElement>(`table[data-spr-kind="${kind}"] tbody tr`),
    );
  const shape = (): string =>
    (document.querySelector('input[name="__shape:groups.eng"]') as HTMLInputElement).value;
  const nameOf = (row: HTMLElement): string =>
    (row.querySelector('input[type="text"]') as HTMLInputElement).name;

  beforeEach(() => {
    renderPartial();
    run();
  });

  it('leaves a stored row on the position the document has it at', () => {
    type('groups.eng.2.id', 'grp-second');

    expect(rows('group')[0].dataset.sprPosition).toBe('1');
    expect(nameOf(rows('group')[0])).toBe('groups.eng.1.id');
    expect((rows('group')[0].querySelector('input[type="hidden"]') as HTMLInputElement).name).toBe(
      'groups.eng.1.provider',
    );
  });

  it('numbers what it adds past the end of the whole sequence', () => {
    type('groups.eng.2.id', 'grp-second');

    expect(nameOf(rows('group')[1])).toBe('groups.eng.2.id');
    expect(rows('group')[2].dataset.sprPosition).toBe('3');
    expect(rows('person')[0].dataset.sprPosition).toBe('4');
  });

  it('keeps the members it cannot see in the shape it sends', () => {
    type('groups.eng.2.id', 'grp-second');
    expect(shape()).toBe('group,group,group,group,person');
  });

  it('leaves the shape alone until something is typed', () => {
    expect(shape()).toBe('group,group');
    type('groups.eng.1.id', 'edited');
    expect(shape()).toBe('group,group');
  });

  it('removes an unsaved row here, as it does on a page holding the whole list', () => {
    type('groups.eng.2.id', 'grp-second');
    expect(rows('group')).toHaveLength(3);

    (rows('group')[1].querySelector('input[data-spr-unsaved]') as HTMLInputElement).checked = true;
    const event = new Event('click', { bubbles: true, cancelable: true });
    document.querySelector<HTMLButtonElement>('.spr-bulk-remove')!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(rows('group')).toHaveLength(2);
    expect(shape()).toBe('group,group');
  });

  it('asks the server to remove a stored row, which knows the position it is at', () => {
    (rows('group')[0].querySelector('input[name="select"]') as HTMLInputElement).checked = true;
    const event = new Event('click', { bubbles: true, cancelable: true });
    document.querySelector<HTMLButtonElement>('.spr-bulk-remove')!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(rows('group')).toHaveLength(2);
    expect(shape()).toBe('group,group');
  });
});

describe('the filter box', () => {
  it('marks itself live, so the sheet can take the button away', () => {
    renderIndex();
    run();
    expect(document.querySelector('.spr-filter')?.hasAttribute('data-spr-live')).toBe(true);
  });

  it('narrows the table on what a row shows', () => {
    renderIndex();
    run();
    expect(shown()).toEqual(['engineering', 'client-northwind']);

    filter('northwind');
    expect(shown()).toEqual(['client-northwind']);

    filter('grp-eng');
    expect(shown()).toEqual(['engineering']);

    filter('');
    expect(shown()).toEqual(['engineering', 'client-northwind']);
  });

  it('tells the two emptinesses apart, and writes no words of its own', () => {
    renderIndex();
    run();
    expect(emptyNone().hidden).toBe(true);
    expect(emptyFiltered().hidden).toBe(true);

    filter('nothing-matches-this');
    expect(shown()).toEqual([]);
    expect(emptyFiltered().hidden).toBe(false);
    expect(emptyNone().hidden).toBe(true);
    expect(emptyFiltered().querySelector('[data-spr-needle]')?.textContent).toBe(
      'nothing-matches-this',
    );
    expect(emptyFiltered().textContent).toContain('Nothing here matches');

    filter('');
    expect(emptyFiltered().hidden).toBe(true);
    expect(emptyNone().hidden).toBe(true);
  });

  it('says the instance has none when the table arrived with no rows at all', () => {
    renderIndex();
    for (const row of rows()) row.remove();
    run();
    expect(emptyNone().hidden).toBe(false);
    expect(emptyFiltered().hidden).toBe(true);
  });

  it('stands down on a page the server already filtered', () => {
    renderIndex('northwind');
    run();
    expect(document.querySelector('.spr-filter')?.hasAttribute('data-spr-live')).toBe(false);

    filter('');
    expect(shown()).toEqual(['engineering', 'client-northwind']);
  });

  it('touches nothing a save carries', () => {
    renderIndex();
    run();
    filter('northwind');
    const shape = document.querySelector('input[name="__shape:groups"]') as HTMLInputElement;
    expect(shape.value).toBe('engineering,client-northwind');
    expect(form().hasAttribute('data-spr-pending')).toBe(false);
  });

  it('does nothing on a page with no table to narrow', () => {
    render();
    expect(run).not.toThrow();
  });
});

describe('the width a model reports', () => {
  function renderModel(dimensions = ''): void {
    document.body.innerHTML = `
      <main>
        <form class="spr-config" method="post" action="/-/config/embedding"
              data-spr-config="embedding">
          <div class="spr-field">
            <input name="embedding.model" type="text" value="" data-spr-width-into="embedding.dimensions">
            <p class="spr-note spr-note-idle" data-spr-width-note hidden></p>
          </div>
          <div class="spr-field">
            <input name="embedding.dimensions" type="number" value="${dimensions}">
          </div>
        </form>
      </main>`;
    run();
  }

  const model = () => document.querySelector('input[name="embedding.model"]') as HTMLInputElement;
  const dimensions = () =>
    document.querySelector('input[name="embedding.dimensions"]') as HTMLInputElement;
  const note = () => document.querySelector('[data-spr-width-note]') as HTMLElement;

  function commit(name: string): void {
    model().value = name;
    model().dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function answered(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  const width = (value: number) => ({
    ok: true,
    json: async () => ({ dimensions: value, model: 'text-embedding-3-small' }),
  });

  it('writes the width the endpoint answers into Dimensions, and says what it did', async () => {
    renderModel();
    fetchMock.mockResolvedValue(width(1536));

    commit('text-embedding-3-small');
    await answered();

    expect(dimensions().value).toBe('1536');
    expect(note().hidden).toBe(false);
    expect(note().className).toContain('spr-note-ok');
    expect(note().textContent).toContain('1536');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/-/config/embedding');
    expect(init.method).toBe('POST');
    expect((init.body as FormData).get('intent')).toBe('width');
  });

  it('asks once per name: a box left with the same name asks nothing', async () => {
    renderModel();
    fetchMock.mockResolvedValue(width(1536));

    commit('text-embedding-3-small');
    await answered();
    commit('text-embedding-3-small');
    await answered();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks nothing for a box cleared', async () => {
    renderModel();
    commit('');
    await answered();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says why the endpoint refused, and leaves Dimensions as it was', async () => {
    renderModel('1536');
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'The endpoint did not answer: embedding endpoint returned 401' }),
    });

    commit('text-embedding-3-large');
    await answered();

    expect(note().className).toContain('spr-note-fail');
    expect(note().textContent).toContain('returned 401');
    expect(dimensions().value).toBe('1536');
  });

  it('says the server could not be asked, and leaves the box for typing', async () => {
    renderModel();
    fetchMock.mockRejectedValue(new Error('offline'));

    commit('text-embedding-3-small');
    await answered();

    expect(note().className).toContain('spr-note-fail');
    expect(note().textContent).toContain('Enter the dimensions by hand');
    expect(dimensions().value).toBe('');
  });

  it("writes the newest name's answer when two come back out of order", async () => {
    renderModel();
    let releaseFirst!: (value: unknown) => void;
    let releaseSecond!: (value: unknown) => void;
    fetchMock
      .mockReturnValueOnce(new Promise((resolve) => (releaseFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (releaseSecond = resolve)));

    commit('text-embedding-3-large');
    commit('text-embedding-3-small');
    releaseSecond(width(512));
    await answered();
    releaseFirst(width(3072));
    await answered();

    expect(dimensions().value).toBe('512');
  });

  function typeInto(value: string): void {
    dimensions().value = value;
    dimensions().dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('never replaces a value typed by hand, and says it is keeping it', async () => {
    renderModel('512');
    fetchMock.mockResolvedValue(width(1536));

    commit('text-embedding-3-large');
    await answered();

    expect(dimensions().value).toBe('512');
    expect(note().className).toContain('spr-note-warn');
    expect(note().textContent).toContain('1536');
    expect(note().textContent).toContain('512');
  });

  it('follows a model change when the width in the box is one it filled in itself', async () => {
    renderModel('');
    fetchMock.mockResolvedValueOnce(width(1536)).mockResolvedValueOnce(width(3072));

    commit('text-embedding-3-small');
    await answered();
    commit('text-embedding-3-large');
    await answered();

    expect(dimensions().value).toBe('3072');
  });

  it('keeps a width typed over the one it filled in, when the model changes after', async () => {
    renderModel('');
    fetchMock.mockResolvedValueOnce(width(1536)).mockResolvedValueOnce(width(3072));

    commit('text-embedding-3-small');
    await answered();
    typeInto('999');
    commit('text-embedding-3-large');
    await answered();

    expect(dimensions().value).toBe('999');
    expect(note().className).toContain('spr-note-warn');
  });

  it('asks again when the box is emptied after a hand edit, and fills it from the answer', async () => {
    renderModel('');
    fetchMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(width(1536));

    commit('text-embedding-3-small');
    await answered();
    expect(note().className).toContain('spr-note-fail');

    typeInto('7');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    typeInto('');
    await answered();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dimensions().value).toBe('1536');
  });

  it('retries a model whose answer failed, once the model is changed to a different name', async () => {
    renderModel('');
    fetchMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(width(1536));

    commit('text-embedding-3-large');
    await answered();
    commit('text-embedding-3-small');
    await answered();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dimensions().value).toBe('1536');
  });

  it('is inert on a page with no model to watch', () => {
    document.body.innerHTML =
      '<main><form class="spr-config" data-spr-config="embedding" action="/-/config/embedding"></form></main>';
    expect(run).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Enter in a field', () => {
  function renderFields(): HTMLFormElement {
    document.body.innerHTML = `
      <main>
        <form class="spr-config" method="post" action="/-/config/identity/entra"
              data-spr-config="identity/entra">
          <input name="auth.providers.entra.client_id" type="text" value="abc">
          <input name="auth.providers.entra.enabled" type="checkbox" value="on">
          <textarea name="brand.tagline"></textarea>
          <details class="spr-modal" open>
            <input name="newname:identity" type="text">
          </details>
          <div class="spr-config-actions">
            <button type="submit" name="intent" value="apply" class="spr-primary spr-config-save">Save</button>
          </div>
        </form>
      </main>`;
    return form();
  }

  // Presses a key on the control, and says whether the browser would go on to submit
  function press(selector: string, init: KeyboardEventInit = { key: 'Enter' }): boolean {
    const control = document.querySelector(selector) as HTMLElement;
    control.focus();
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    control.dispatchEvent(event);
    return !event.defaultPrevented;
  }

  const CLIENT_ID = '[name="auth.providers.entra.client_id"]';

  it('leaves a text field without submitting', () => {
    renderFields();
    run();

    expect(press(CLIENT_ID)).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('is blocked on a checkbox, which stays focused', () => {
    renderFields();
    run();

    expect(press('[type="checkbox"]')).toBe(false);
    expect(document.activeElement).toBe(document.querySelector('[type="checkbox"]'));
  });

  it('keeps its newline in a textarea', () => {
    renderFields();
    run();

    expect(press('textarea')).toBe(true);
  });

  it('keeps its job on the Save button', () => {
    renderFields();
    run();

    expect(press('.spr-config-save')).toBe(true);
  });

  it('leaves a modal field to the browser, with focus kept', () => {
    renderFields();
    run();

    expect(press('.spr-modal input')).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('.spr-modal input'));
  });

  it('ignores other keys', () => {
    renderFields();
    run();

    expect(press(CLIENT_ID, { key: 'a' })).toBe(true);
    expect(document.activeElement).toBe(document.querySelector(CLIENT_ID));
  });

  it('waits out an input method that is still composing', () => {
    renderFields();
    run();

    expect(press(CLIENT_ID, { key: 'Enter', isComposing: true })).toBe(true);
    expect(document.activeElement).toBe(document.querySelector(CLIENT_ID));
  });

  it('still saves with the Save button', () => {
    renderFields();
    run();

    expect(pressSave()).toBe(true);
  });
});
