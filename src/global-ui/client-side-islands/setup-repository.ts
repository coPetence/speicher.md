/**
 * The table of the setup's repository step: the checks of the GitHub sources, and its refresh
 *
 * Each GitHub source's check asks GitHub, so the page is drawn without it and
 * this asks the check address once per source. What the check found goes into
 * the source's place above the table, and into the `.speicher.yaml` cells of its
 * rows; the repositories no sync has found yet are added
 *
 * The refresh asks for the page again while it is visible, often while a sync
 * or a discovery is queued or running. It takes the sync and readable cells of
 * every row, and the `.speicher.yaml` cells of the rows no check has filled, so
 * GitHub is not asked again. It stops once the administrator can read a repository
 *
 * The filter box narrows the table as on the sync status page, and narrows the
 * rows the checks and the refresh add too
 *
 * The card `[data-spr-repository-step]` acts as a mount guard
 */

import { mountFilter } from './filter';

const REFRESH_MS = 10_000;
const BUSY_REFRESH_MS = 3_000;

const STEP = '[data-spr-repository-step]';
const ROWS = '[data-spr-repository-table] > tbody';
// The rows of repositories, not the ones that say a check is still running
const REPOSITORY_ROWS = `${ROWS} > tr[data-spr-repo-row]`;
const SWAPPED = [
  '[data-spr-setup-region="group"]',
  '[data-spr-setup-region="discovering"]',
  '[data-spr-setup-status]',
  '.spr-guide',
];
const DONE = '[data-spr-readable]';

// Narrows the rows again after rows were added or swapped; none when the server narrowed the page
let refilter: (() => void) | null = null;

export function mountRepositoryStep(): void {
  if (!document.querySelector(STEP)) return;
  refilter = mountFilter('[data-spr-repository-table]');
  mountChecks();
  mountRefresh();
  mountConfigFilePicker();
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

function mountChecks(): void {
  for (const place of document.querySelectorAll<HTMLElement>('[data-spr-check-href]')) {
    const href = place.dataset.sprCheckHref ?? '';
    const source = place.dataset.sprCheck ?? '';
    const loading = document.querySelector<HTMLElement>(
      `[data-spr-check-loading="${CSS.escape(source)}"]`,
    );
    const link = loading?.querySelector('[data-spr-check-text] a');
    // The link is for where nothing runs; here the check starts by itself
    link?.remove();

    void (async () => {
      try {
        const fresh = await page(href);
        const found = fresh.querySelector(`[data-spr-check="${CSS.escape(source)}"]`);
        if (!found) throw new Error('the check answered without its result');
        place.replaceWith(document.importNode(found, true));
        for (const row of fresh.querySelectorAll<HTMLElement>(REPOSITORY_ROWS)) {
          if (row.dataset.sprSource !== source || !row.hasAttribute('data-spr-checked')) continue;
          const current = rowNamed(row.dataset.sprRepoRow ?? '');
          if (current) current.replaceWith(document.importNode(row, true));
          else append(row);
        }
        loading?.remove();
        refilter?.();
      } catch {
        // Offer the link again, to run the check by loading its page
        place.removeAttribute('aria-busy');
        const text = loading?.querySelector('[data-spr-check-text]');
        if (text && link) {
          text.textContent = `The check of ${source} did not finish here. `;
          text.append(link);
        }
      }
    })();
  }
}

function mountRefresh(): void {
  let timer = 0;

  const schedule = (): void => {
    window.clearTimeout(timer);
    if (document.hidden || document.querySelector(DONE)) return;
    const busy = document.querySelector(STEP)?.hasAttribute('data-spr-busy') === true;
    timer = window.setTimeout(() => void refresh(), busy ? BUSY_REFRESH_MS : REFRESH_MS);
  };

  const refresh = async (): Promise<void> => {
    try {
      swap(await page(window.location.pathname + window.location.search));
    } catch {
      // Offline or the server restarting; the next tick asks again
    }
    schedule();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) window.clearTimeout(timer);
    else void refresh();
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

function swap(fresh: Document): void {
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
      continue;
    }
    // A check knows more of the file than the sync, so its cells stay
    const cells = current.hasAttribute('data-spr-checked')
      ? ['sync', 'readable']
      : ['file', 'access', 'sync', 'readable'];
    for (const cell of cells) {
      const now = current.querySelector(`[data-spr-cell="${cell}"]`);
      const next = row.querySelector(`[data-spr-cell="${cell}"]`);
      if (now && next && now.innerHTML !== next.innerHTML) now.innerHTML = next.innerHTML;
    }
    // The name links to the sync status once a sync has found it
    const name = current.querySelector(':scope > th');
    const nextName = row.querySelector(':scope > th');
    if (name && nextName?.querySelector('a[href^="/-/status/"]'))
      name.innerHTML = nextName.innerHTML;
  }

  const step = document.querySelector(STEP);
  const nextStep = fresh.querySelector(STEP);
  if (step && nextStep) {
    step.toggleAttribute('data-spr-busy', nextStep.hasAttribute('data-spr-busy'));
  }
  refilter?.();
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
  // Above the rows that say a check is still running
  body.insertBefore(document.importNode(row, true), body.querySelector('[data-spr-check-loading]'));
  const table = body.closest<HTMLElement>('.spr-scroll');
  if (table) table.hidden = false;
  const none = document.querySelector<HTMLElement>('[data-spr-empty="none"]');
  if (none) none.hidden = true;
}
