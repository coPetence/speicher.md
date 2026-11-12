/**
 * The repositories page: its next step, the checks of the GitHub sources, and its refresh
 *
 * The checks ask GitHub, so the page is drawn without them, and its next step
 * says it is checking. This asks the check address once, and puts the step it
 * answers with in that place, and the rows it found into the table
 *
 * The refresh asks for the page again while it is visible, often while a sync
 * or a discovery is queued or running. It takes the sync and readable cells of
 * every row, and the `.speicher.yaml` cells of the rows no check has filled. A
 * page without the checks cannot say the next step, so the checks run again
 * when a row changed. The Refresh button runs them whenever the person asks,
 * and shows every run. The refresh stops once the administrator can read a
 * repository
 *
 * The filter box narrows the table as on the sync status page, and narrows the
 * rows the checks and the refresh add too
 *
 * The card `[data-spr-repository-step]` acts as a mount guard
 */

import { lookUpSources, mountAddRepository, takeSources } from './add-repository';
import { mountFilter } from './filter';

const REFRESH_MS = 10_000;
const BUSY_REFRESH_MS = 3_000;

const STEP = '[data-spr-repository-step]';
const FIX = '[data-spr-setup-fix-region]';
const ROWS = '[data-spr-repository-table] > tbody';
const REPOSITORY_ROWS = `${ROWS} > tr[data-spr-repo-row]`;
const SWAPPED = ['[data-spr-setup-region="group"]', '.spr-guide'];
const DONE = '[data-spr-readable]';
const REFRESH = 'form[data-spr-refresh]';
const SYNC_AGAIN = `${FIX} form[data-spr-auto="on-return"]`;
const DONE_ON_GITHUB = ['create-repository', 'no-repository', 'no-page']
  .map((id) => `${FIX} [data-spr-setup-fix="${id}"]`)
  .join(', ');

// Narrows the rows again after rows were added or swapped; none when the server narrowed the page
let refilter: (() => void) | null = null;
let running: Promise<boolean> | null = null;
let refreshNow: (() => Promise<void>) | null = null;
const posted = new Set<string>();

export function mountRepositoryStep(): void {
  if (!document.querySelector(STEP)) return;
  refilter = mountFilter('[data-spr-repository-table]');
  mountRefreshButton();
  // In this order, so the checks reuse the App and the token the lookup asked GitHub for
  void lookUpSources(page)
    .then(() => check(document.querySelector<HTMLElement>(FIX)?.dataset.sprCheckHref))
    .then(() => postAuto('now'));
  mountRefresh();
  mountConfigFilePicker();
  mountAddRepository(check);
}

function mountRefreshButton(): void {
  const form = document.querySelector<HTMLFormElement>(REFRESH);
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!document.querySelector(SYNC_AGAIN)) {
      void check(freshCheckHref());
      return;
    }
    showChecking(true);
    void postAuto('on-return').finally(() => showChecking(false));
  });
}

// The address of the Refresh button, which asks GitHub for everything
function freshCheckHref(): string | undefined {
  const form = document.querySelector<HTMLFormElement>(REFRESH);
  if (!form) return undefined;
  const query = new URLSearchParams([...new FormData(form)] as [string, string][]);
  return `${form.getAttribute('action')}?${query}`;
}

function showChecking(running: boolean): void {
  const button = document.querySelector<HTMLButtonElement>(`${REFRESH} button`);
  if (!button) return;
  button.disabled = running;
  button.querySelector('svg')?.classList.toggle('spr-spin', running);
  const label = button.querySelector('span');
  if (label) label.textContent = running ? 'Refreshing…' : 'Refresh';
}

/**
 * Opens the modal of a new `.speicher.yaml` in place for a Create link, filled in for its repository, so neither
 * opening nor closing it loads the page, and with it the checks, again
 */
function mountConfigFilePicker(): void {
  const modal = document.querySelector<HTMLDetailsElement>('[data-spr-config-file-picker]');
  const form = modal?.querySelector('form');
  if (!modal || !form) return;
  const name = modal.querySelector('[data-spr-config-file-repository]');
  const none = modal.querySelector<HTMLElement>('[data-spr-config-file-none]');

  // On the document, so rows added by a check or the refresh are covered too
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const create = target?.closest<HTMLAnchorElement>('a[data-spr-config-file-action]');
    if (create) {
      event.preventDefault();
      form.action = create.dataset.sprConfigFileAction ?? '';
      if (name) name.textContent = create.dataset.sprConfigFileRepository ?? '';
      if (none) none.hidden = true;
      modal.open = true;
      return;
    }
    if (target?.closest('[data-spr-config-file-back]') && modal.contains(target)) {
      event.preventDefault();
      modal.open = false;
    }
  });

  // A group picked answers the problem
  form.addEventListener('change', () => {
    if (none && form.querySelector('input[name="grant"]:checked')) none.hidden = true;
  });

  form.addEventListener('submit', (event) => {
    // Asked here rather than on a page the new tab would open
    if (!form.querySelector('input[name="grant"]:checked')) {
      event.preventDefault();
      if (none) none.hidden = false;
      return;
    }
    // GitHub opens in a new tab; this one goes back to the table
    window.setTimeout(() => {
      modal.open = false;
    });
  });
}

/**
 * Runs the checks of the GitHub sources at their address, and puts the next step and the rows they found in place.
 * A caller that asks during a run gets the answer of that run.
 *
 * @param href the check address, or undefined when the page has no checks to run
 */
function check(href: string | undefined): Promise<boolean> {
  if (!href) return Promise.resolve(false);
  running ??= runCheck(href).finally(() => {
    running = null;
  });
  return running;
}

async function runCheck(href: string): Promise<boolean> {
  showChecking(true);
  try {
    const fresh = await page(href);
    const next = fresh.querySelector(FIX);
    if (!next || next.hasAttribute('data-spr-check-href')) {
      throw new Error('the check answered without its result');
    }
    for (const row of fresh.querySelectorAll<HTMLElement>(REPOSITORY_ROWS)) {
      if (!row.hasAttribute('data-spr-checked')) continue;
      const current = rowNamed(row.dataset.sprRepoRow ?? '');
      if (current) current.replaceWith(document.importNode(row, true));
      else append(row);
    }
    removeMissing(fresh, true);
    putInOrder(fresh);
    updateJobsRunningFlag(fresh);
    replaceFix(next);
    takeSources(fresh);
    refilter?.();
    return true;
  } catch {
    // Offer to run the check by loading its page
    const note = document.querySelector(`${FIX} .spr-setup-fix-note`);
    if (note) {
      const again = document.createElement('a');
      again.href = href;
      again.textContent = 'Check again';
      note.textContent = 'The check did not finish. ';
      note.append(again);
    }
    return false;
  } finally {
    showChecking(false);
  }
}

function removeMissing(fresh: Document, checked: boolean): boolean {
  const known = new Set(
    [...fresh.querySelectorAll<HTMLElement>(REPOSITORY_ROWS)].map((row) => row.dataset.sprRepoRow),
  );
  let removed = false;
  for (const row of document.querySelectorAll<HTMLElement>(REPOSITORY_ROWS)) {
    if (known.has(row.dataset.sprRepoRow)) continue;
    if (!checked && row.hasAttribute('data-spr-checked')) continue;
    row.remove();
    removed = true;
  }
  const table = document.querySelector<HTMLElement>(`${STEP} .spr-scroll`);
  if (removed && table && !document.querySelector(REPOSITORY_ROWS)) table.hidden = true;
  return removed;
}

// The rows in the order the server sorted them, which what the check found may have changed
function putInOrder(fresh: Document): void {
  const body = document.querySelector(ROWS);
  for (const row of fresh.querySelectorAll<HTMLElement>(REPOSITORY_ROWS)) {
    const current = rowNamed(row.dataset.sprRepoRow ?? '');
    if (current) body?.append(current);
  }
}

// The next step in place of the current one, and the table shown once there is no step before the repositories
function replaceFix(next: Element): void {
  document.querySelector(FIX)?.replaceWith(document.importNode(next, true));
  const step = document.querySelector<HTMLElement>(STEP);
  if (!step) return;
  const blocked = next.hasAttribute('data-spr-blocked');
  const filtered = new URLSearchParams(window.location.search).has('q');
  step.hidden = blocked || (!document.querySelector(REPOSITORY_ROWS) && !filtered);
  void postAuto('now');
}

async function postAuto(when: 'now' | 'on-return'): Promise<boolean> {
  const form = document.querySelector<HTMLFormElement>(`${FIX} form[data-spr-auto="${when}"]`);
  if (!form) return false;
  const body = new URLSearchParams([...new FormData(form)] as [string, string][]);
  const key = `${form.getAttribute('action')}?${body}`;
  if (when === 'now' && posted.has(key)) return false;
  posted.add(key);
  try {
    const response = await fetch(form.getAttribute('action') ?? '', {
      method: 'POST',
      body,
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!response.ok) return false;
  } catch {
    return false;
  }
  // A check that put the step in place is done before the page is asked again
  if (running) await running;
  await refreshNow?.();
  return true;
}

function mountRefresh(): void {
  let timer = 0;

  const schedule = (): void => {
    window.clearTimeout(timer);
    if (document.hidden || document.querySelector(DONE)) return;
    const busy = document.querySelector(STEP)?.hasAttribute('data-spr-busy') === true;
    timer = window.setTimeout(() => void refresh(), busy ? BUSY_REFRESH_MS : REFRESH_MS);
  };

  const refresh = async (force = false): Promise<void> => {
    try {
      const fresh = await page(window.location.pathname + window.location.search);
      const changed = swap(fresh);
      const next = fresh.querySelector<HTMLElement>(FIX);
      const href = next?.dataset.sprCheckHref;
      const current = document.querySelector(FIX);
      if (next && !next.querySelector('[data-spr-setup-fix="checking"]')) {
        replaceFix(next);
      } else if (force || changed || current?.hasAttribute('data-spr-blocked')) {
        await check(href);
      }
    } catch {
      // Offline or the server restarting; the next tick asks again
    }
    schedule();
  };
  refreshNow = () => refresh(true);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      window.clearTimeout(timer);
    } else if (document.querySelector(DONE_ON_GITHUB)) {
      void postAuto('on-return').then((synced) =>
        synced ? undefined : check(freshCheckHref()).finally(schedule),
      );
    } else {
      void refresh();
    }
  });

  schedule();
}

async function page(href: string): Promise<Document> {
  const response = await fetch(href, {
    headers: { Accept: 'text/html' },
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`the page answered ${response.status}`);
  return new DOMParser().parseFromString(await response.text(), 'text/html');
}

// Takes what the fresh page knows; true when a row was added or changed, which the next step may depend on
function swap(fresh: Document): boolean {
  let changed = false;
  for (const selector of SWAPPED) {
    const current = document.querySelector(selector);
    const next = fresh.querySelector(selector);
    if (current && next && current.outerHTML !== next.outerHTML) {
      current.replaceWith(document.importNode(next, true));
    }
  }

  for (const row of fresh.querySelectorAll<HTMLElement>(REPOSITORY_ROWS)) {
    const current = rowNamed(row.dataset.sprRepoRow ?? '');
    if (!current) {
      append(row);
      changed = true;
      continue;
    }
    // A check knows more of the file than the sync, so its cells stay
    const cells = current.hasAttribute('data-spr-checked')
      ? ['sync', 'readable']
      : ['file', 'access', 'sync', 'readable'];
    for (const cell of cells) {
      const now = current.querySelector(`[data-spr-cell="${cell}"]`);
      const next = row.querySelector(`[data-spr-cell="${cell}"]`);
      if (now && next && now.innerHTML !== next.innerHTML) {
        now.innerHTML = next.innerHTML;
        changed = true;
      }
    }
    // The name links to the sync status once a sync has found it
    const name = current.querySelector(':scope > th');
    const nextName = row.querySelector(':scope > th');
    if (name && nextName?.querySelector('a[href^="/-/status/"]'))
      name.innerHTML = nextName.innerHTML;
  }
  if (removeMissing(fresh, false)) changed = true;

  if (updateJobsRunningFlag(fresh)) changed = true;
  refilter?.();
  return changed;
}

/**
 * Sets whether a sync or a discovery is queued or running. It returns true when that changed.
 *
 * @param freshPage the page the server answered with
 */
function updateJobsRunningFlag(freshPage: Document): boolean {
  const currentStep = document.querySelector(STEP);
  const freshStep = freshPage.querySelector(STEP);
  if (!currentStep || !freshStep) return false;
  const jobsRunning = freshStep.hasAttribute('data-spr-busy');
  if (currentStep.hasAttribute('data-spr-busy') === jobsRunning) return false;
  currentStep.toggleAttribute('data-spr-busy', jobsRunning);
  return true;
}

function rowNamed(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `${ROWS} > tr[data-spr-repo-row="${CSS.escape(name)}"]`,
  );
}

// A row the page did not have yet, which shows the table if it was empty
function append(row: HTMLElement): void {
  const body = document.querySelector(ROWS);
  if (!body) return;
  body.append(document.importNode(row, true));
  const table = body.closest<HTMLElement>('.spr-scroll');
  if (table) table.hidden = false;
  const step = document.querySelector<HTMLElement>(STEP);
  if (step && !document.querySelector(`${FIX}[data-spr-blocked]`)) step.hidden = false;
}
