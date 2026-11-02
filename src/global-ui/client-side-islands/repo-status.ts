/**
 * Client-side island for the repository sync status page
 *
 * Polls the server while a sync is in-flight and reloads when it completes
 * Mounts nav folds for collapsible details/summary sections
 */

import { mountNav } from './slide';

const POLL_MS = 3_000;

const GIVE_UP_MS = 30 * 60 * 1000;

function mountSyncWatch(): void {
  if (!document.querySelector('[data-spr-syncing]')) return;

  const startedAt = Date.now();
  let timer = 0;

  const schedule = (): void => {
    window.clearTimeout(timer);
    if (document.hidden || Date.now() - startedAt > GIVE_UP_MS) return;
    timer = window.setTimeout(() => void tick(), POLL_MS);
  };

  const tick = async (): Promise<void> => {
    try {
      const response = await fetch(window.location.pathname, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (response.ok) {
        const body = (await response.json()) as { syncing?: unknown };
        if (body.syncing === false) {
          window.location.reload();
          return;
        }
      }
    } catch {
      //
    }
    schedule();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) window.clearTimeout(timer);
    else void tick();
  });

  schedule();
}

function mountFindingsToggles(): void {
  for (const toggle of document.querySelectorAll<HTMLElement>('[data-spr-findings-toggle]')) {
    const row = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    if (!row) continue;
    toggle.setAttribute('role', 'button');
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      row.hidden = !row.hidden;
      toggle.setAttribute('aria-expanded', String(!row.hidden));
    });
  }
}

function mount(): void {
  mountNav();
  mountSyncWatch();
  mountFindingsToggles();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
