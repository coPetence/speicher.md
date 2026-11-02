/**
 * Client-side island for the sync-status page
 *
 * Mounts the nav fold slide animation and cookie persistence, then the live
 * filter on the status table, the state menu, and the refresh that keeps the
 * tiles and the table current
 *
 * The table selector isolates the status table from other `.spr-table` elements
 * on the page (the configurator uses `.spr-table.spr-entries` and
 * `.spr-table.spr-rows`)
 *
 * No exports — runs as a side-effect when loaded as an ESM module
 */

import { mountFilter } from './filter';
import { mountNav } from './slide';

// Selects the status table specifically; other tables with class `.spr-table`
// do not carry `data-spr-rows`
const TABLE = '.spr-table[data-spr-rows]';

const REFRESH_MS = 5_000;
const BUSY_REFRESH_MS = 1_000;
const BUSY = '[data-spr-activity][data-spr-busy]';

// The regions of the page that are replaced
const REGIONS = [
  '.spr-stats',
  '[data-spr-activity]',
  `${TABLE} > tbody`,
  '[data-spr-empty="none"]',
  '[data-spr-empty="filtered"]',
];

const TOGGLED = ['.spr-scroll', '[data-spr-empty="none"]', '[data-spr-empty="filtered"]'];

function mount(): void {
  const sent = REGIONS.map((selector) => document.querySelector(selector)?.innerHTML ?? null);
  // Nav fold animation and open-state cookie; status page has a side nav
  mountNav();
  // Live text filter on the repository table
  const reapply = mountFilter(TABLE);
  mountFilterDialog();
  mountRefresh(sent, reapply);
}

/**
 * Asks for the page again every few seconds while it is visible, and swaps in the
 * regions whose markup changed since the last answer
 */
function mountRefresh(sent: (string | null)[], reapply: (() => void) | null): void {
  if (!document.querySelector(TABLE)) return;
  const last = [...sent];
  let timer = 0;
  let busy = document.querySelector(BUSY) !== null;

  const schedule = (): void => {
    window.clearTimeout(timer);
    if (document.hidden) return;
    timer = window.setTimeout(() => void refresh(), busy ? BUSY_REFRESH_MS : REFRESH_MS);
  };

  const refresh = async (): Promise<void> => {
    try {
      const response = await fetch(window.location.href, {
        headers: { Accept: 'text/html' },
        credentials: 'same-origin',
      });
      if (response.ok) {
        const fresh = new DOMParser().parseFromString(await response.text(), 'text/html');
        if (fresh.querySelector(TABLE)) {
          swap(fresh, last, reapply);
          busy = fresh.querySelector(BUSY) !== null;
        }
      }
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

function swap(fresh: Document, last: (string | null)[], reapply: (() => void) | null): void {
  const opened = new Set(
    [...document.querySelectorAll<HTMLDetailsElement>('details[data-spr-repo][open]')].map(
      (details) => details.dataset.sprRepo,
    ),
  );

  let changed = false;
  REGIONS.forEach((selector, index) => {
    const current = document.querySelector(selector);
    const next = fresh.querySelector(selector);
    if (!current || !next || next.innerHTML === last[index]) return;
    current.innerHTML = next.innerHTML;
    last[index] = next.innerHTML;
    changed = true;
  });

  const counts = new Map(
    [...fresh.querySelectorAll<HTMLInputElement>('[data-spr-group-panel] input')].map((box) => [
      `${box.name}=${box.value}`,
      box.closest('label')?.querySelector('.spr-filter-count')?.textContent ?? null,
    ]),
  );
  for (const box of document.querySelectorAll<HTMLInputElement>('[data-spr-group-panel] input')) {
    const next = counts.get(`${box.name}=${box.value}`);
    const count = box.closest('label')?.querySelector('.spr-filter-count');
    if (count && next !== undefined && next !== null) count.textContent = next;
  }

  if (!changed) return;
  for (const selector of TOGGLED) {
    const current = document.querySelector<HTMLElement>(selector);
    const next = fresh.querySelector<HTMLElement>(selector);
    if (current && next) current.hidden = next.hidden;
  }
  for (const details of document.querySelectorAll<HTMLDetailsElement>('details[data-spr-repo]')) {
    if (opened.has(details.dataset.sprRepo)) details.open = true;
  }
  reapply?.();
}

function mountFilterDialog(): void {
  const modal = document.querySelector<HTMLDetailsElement>(
    'form[data-spr-filter] .spr-filter-modal',
  );
  const dialog = modal?.querySelector<HTMLElement>('.spr-filter-dialog');
  const form = modal?.closest('form');
  if (!modal || !dialog || !form) return;

  const rows = JSON.parse(dialog.dataset.sprFacets ?? '[]') as Record<string, string>[];
  const groups = [...dialog.querySelectorAll<HTMLElement>('[data-spr-group]')];
  const panels = [...dialog.querySelectorAll<HTMLElement>('[data-spr-group-panel]')];
  const boxes = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const searches = [...dialog.querySelectorAll<HTMLInputElement>('[data-spr-option-search]')];
  const applied = boxes.map((box) => box.checked);
  let submitting = false;

  dialog.setAttribute('data-spr-live', '');

  const show = (key: string): void => {
    for (const group of groups) {
      if (group.dataset.sprGroup === key) group.setAttribute('aria-current', 'true');
      else group.removeAttribute('aria-current');
    }
    for (const panel of panels) {
      panel.toggleAttribute('data-spr-current', panel.dataset.sprGroupPanel === key);
    }
  };

  const update = (): void => {
    const chosen: Record<string, string[]> = {};
    for (const panel of panels) {
      const key = panel.dataset.sprGroupPanel ?? '';
      chosen[key] = [
        ...panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'),
      ].map((box) => box.value);
      const selected = panel.querySelector('[data-spr-selected]');
      if (selected) selected.textContent = String(chosen[key].length);
      const count = groups
        .find((group) => group.dataset.sprGroup === key)
        ?.querySelector('[data-spr-group-count]');
      if (count) count.textContent = chosen[key].length > 0 ? String(chosen[key].length) : '';
    }
    const narrowing = Object.entries(chosen).filter(([, values]) => values.length > 0);
    const appliedCount = dialog.querySelector('[data-spr-applied]');
    if (appliedCount) appliedCount.textContent = String(narrowing.length);
    const results = dialog.querySelector('[data-spr-results]');
    if (results) {
      results.textContent = String(
        rows.filter((row) => narrowing.every(([key, values]) => values.includes(row[key]))).length,
      );
    }
  };

  const narrowOptions = (search: HTMLInputElement): void => {
    const needle = search.value.trim().toLowerCase();
    const panel = search.closest('[data-spr-group-panel]');
    for (const label of panel?.querySelectorAll<HTMLElement>('label[data-spr-option]') ?? []) {
      label.hidden = needle !== '' && !(label.dataset.sprOption ?? '').includes(needle);
    }
  };

  dialog.addEventListener('change', update);
  dialog.addEventListener('input', (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    if (!event.target.matches('[data-spr-option-search]')) return;
    event.stopPropagation();
    narrowOptions(event.target);
  });
  dialog.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const group = target?.closest<HTMLElement>('[data-spr-group]');
    if (group) {
      show(group.dataset.sprGroup ?? '');
    } else if (target?.closest('[data-spr-select-all]')) {
      const panel = target.closest('[data-spr-group-panel]');
      for (const box of panel?.querySelectorAll<HTMLInputElement>(
        'label:not([hidden]) input[type="checkbox"]',
      ) ?? []) {
        box.checked = true;
      }
      update();
    } else if (target?.closest('[data-spr-filter-clear]')) {
      for (const box of boxes) box.checked = false;
      update();
    } else if (target?.closest('[data-spr-filter-cancel]')) {
      modal.open = false;
    }
  });

  form.addEventListener('submit', () => {
    submitting = true;
  });
  modal.addEventListener('toggle', () => {
    if (modal.open || submitting) return;
    boxes.forEach((box, index) => {
      box.checked = applied[index];
    });
    for (const search of searches) {
      search.value = '';
      narrowOptions(search);
    }
    update();
  });
  addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !modal.open) return;
    modal.open = false;
    modal.querySelector('summary')?.focus();
  });

  show(
    groups.find((group) => group.getAttribute('aria-current') === 'true')?.dataset.sprGroup ??
      groups[0]?.dataset.sprGroup ??
      '',
  );
  update();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
