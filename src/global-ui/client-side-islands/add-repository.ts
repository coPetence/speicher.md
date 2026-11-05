/**
 * The modal of the repositories page that adds a repository
 *
 * Its first screen picks the content source. Open on GitHub leaves the page, so
 * it saves the repositories of the source in this tab. Once the tab comes back,
 * the modal opens again on its second screen, which lists the repositories that
 * are not among the saved ones
 */

interface Pending {
  source: string;
  keys: string[];
  at: number;
}

const MODAL = '[data-spr-add-repository]';
const SOURCE = '[data-spr-add-source]';
const PENDING = 'spr-add-repository';
const PENDING_MS = 30 * 60 * 1000;

// Shows the picked source again after its panel changed
let showPicked: (() => void) | null = null;

/**
 * mountAddRepository wires up the modal, and opens it again when the tab comes back from GitHub.
 *
 * @param checkNow runs the checks at an address, and says whether they finished
 */
export function mountAddRepository(checkNow: (href: string) => Promise<boolean>): void {
  const modal = document.querySelector<HTMLDetailsElement>(MODAL);
  const title = modal?.querySelector<HTMLElement>('[data-spr-add-title]');
  const start = modal?.querySelector<HTMLElement>('[data-spr-add-start]');
  const result = modal?.querySelector<HTMLElement>('[data-spr-add-result]');
  const looking = modal?.querySelector<HTMLElement>('[data-spr-add-looking]');
  const status = modal?.querySelector<HTMLElement>('[data-spr-add-status]');
  const list = modal?.querySelector<HTMLElement>('[data-spr-add-found]');
  const again = result?.querySelector<HTMLButtonElement>('[data-spr-add-check]');
  if (!modal || !title || !start || !result || !looking || !status || !list || !again) return;
  const pick = modal.querySelector<HTMLSelectElement>('[data-spr-add-source-pick]');
  const startTitle = title.textContent ?? '';

  let before: Set<string> | null = null;
  let found: HTMLElement[] = [];

  const panels = (): HTMLElement[] => [...modal.querySelectorAll<HTMLElement>(SOURCE)];
  const current = (): HTMLElement | null =>
    panels().find((panel) => !pick || panel.dataset.sprAddSource === pick.value) ?? null;

  const say = (text: string): void => {
    status.textContent = text;
    status.hidden = text === '';
  };

  const showResult = (shown: boolean): void => {
    start.hidden = shown;
    result.hidden = !shown;
    title.textContent = shown ? 'New repositories' : startTitle;
  };

  showPicked = (): void => {
    const picked = current();
    for (const panel of panels()) panel.hidden = panel !== picked;
  };

  const reset = (): void => {
    before = null;
    found = [];
    say('');
    list.replaceChildren();
    list.hidden = true;
    showResult(false);
    showPicked?.();
  };

  const look = async (): Promise<void> => {
    const panel = current();
    if (!panel) return;
    const source = panel.dataset.sprAddSource ?? '';
    const seen = before ?? new Set(knownIn(panel));
    before = seen;
    showResult(true);
    say('');
    looking.hidden = false;
    again.disabled = true;
    const answered = await checkNow(modal.dataset.sprCheckAddress ?? '');
    looking.hidden = true;
    again.disabled = false;
    if (before !== seen) return;
    if (!answered) {
      say('Speicher.md could not finish the check. To try again, press Check again.');
      return;
    }

    const picked = current() ?? panel;
    const added = knownIn(picked).filter((key) => !seen.has(key));
    if (added.length > 0) discover(source);
    for (const key of added) seen.add(key);
    found.push(...rowsOf(picked, added));
    if (found.length === 0) {
      say(
        `Speicher.md found no new repository in ${source} yet. If you just saved on GitHub, wait a moment and check again.`,
      );
      return;
    }
    say(
      found.length === 1
        ? `Speicher.md found a new repository in ${source}.`
        : `Speicher.md found ${found.length} new repositories in ${source}.`,
    );
    list.replaceChildren(...found);
    list.hidden = false;
  };

  const resume = (): void => {
    const pending = takePending();
    if (!pending || !panels().some((panel) => panel.dataset.sprAddSource === pending.source)) {
      return;
    }
    if (pick) pick.value = pending.source;
    showPicked?.();
    found = [];
    before = new Set(pending.keys);
    modal.open = true;
    void look();
  };

  pick?.addEventListener('change', () => showPicked?.());
  modal.addEventListener('toggle', () => {
    if (!modal.open) reset();
  });
  modal.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (target?.closest('[data-spr-add-open]')) {
      const panel = current();
      if (panel) remember(panel);
    } else if (target?.closest('[data-spr-add-check]')) {
      void look();
    } else if (target?.closest('a[data-spr-config-file-action]')) {
      // The modal of the new `.speicher.yaml` takes its place
      modal.open = false;
    }
  });
  // Back from GitHub restores the page as it was left, which mounts nothing again
  addEventListener('pageshow', (event) => {
    if (event.persisted) resume();
  });

  showPicked();
  resume();
}

/**
 * lookUpSources asks for the installations the page was drawn without, which is far quicker than the checks.
 *
 * @param load loads a page of this site
 */
export async function lookUpSources(load: (href: string) => Promise<Document>): Promise<void> {
  const modal = document.querySelector<HTMLElement>(MODAL);
  if (!modal?.querySelector('[data-spr-add-pending]')) return;
  try {
    takeSources(await load(modal.dataset.sprLookupAddress ?? ''));
  } catch {
    for (const note of modal.querySelectorAll('[data-spr-add-lookup]')) {
      note.textContent =
        'Speicher.md could not look up the GitHub App. To try again, reload the page.';
    }
  }
}

/**
 * takeSources puts what a check knows of the content sources into the modal.
 *
 * @param fresh the page the check answered with
 */
export function takeSources(fresh: Document): void {
  const modal = document.querySelector(MODAL);
  if (!modal) return;
  const panels = [...modal.querySelectorAll<HTMLElement>(SOURCE)];
  for (const next of fresh.querySelectorAll<HTMLElement>(`${MODAL} ${SOURCE}`)) {
    panels
      .find((panel) => panel.dataset.sprAddSource === next.dataset.sprAddSource)
      ?.replaceWith(document.importNode(next, true));
  }
  showPicked?.();
}

function knownIn(panel: HTMLElement): string[] {
  return (panel.dataset.sprKnown ?? '').split(' ').filter((key) => key !== '');
}

// The rows the server drew for the given repositories
function rowsOf(panel: HTMLElement, keys: string[]): HTMLElement[] {
  const rows = panel.querySelector('template')?.content;
  if (!rows) return [];
  return [...rows.querySelectorAll<HTMLElement>('[data-spr-add-key]')]
    .filter((row) => keys.includes(row.dataset.sprAddKey ?? ''))
    .map((row) => document.importNode(row, true));
}

function remember(panel: HTMLElement): void {
  const pending: Pending = {
    source: panel.dataset.sprAddSource ?? '',
    keys: knownIn(panel),
    at: Date.now(),
  };
  sessionStorage.setItem(PENDING, JSON.stringify(pending));
}

function takePending(): Pending | null {
  const stored = sessionStorage.getItem(PENDING);
  sessionStorage.removeItem(PENDING);
  const pending = stored ? (JSON.parse(stored) as Pending) : null;
  return pending && Date.now() - pending.at < PENDING_MS ? pending : null;
}

// A webhook may not reach this instance, so the sync is asked for here
function discover(source: string): void {
  void fetch('/-/discover', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    body: new URLSearchParams({ source }),
  }).catch(() => undefined);
}
