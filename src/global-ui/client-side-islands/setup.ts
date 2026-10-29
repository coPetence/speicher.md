/**
 * Polling on the setup claim page
 *
 * Fetches `/api/setup/claim` every 2 s until the status is `approved` or `gone`,
 * then redirects to `/`
 * Also mounts the copy-buttons module from the sibling file
 *
 * The setup claim page is the front door of an unconfigured instance
 * It tells the caller to run a CLI command, and this client polls to detect
 * when the command has succeeded
 *
 * A link `[data-spr-setup-refresh]` on the page acts as a mount guard
 *
 * Also serves the setup's repository step: the nav column, and its table with
 * the GitHub checks and the refresh
 */

import { mountModals } from './configurator/modal-focus-and-escape';
import { mountWalkthroughs } from './configurator/walkthrough';
import { mountCopy } from './copy';
import { mountRepositoryStep } from './setup-repository';
import { mountNav } from './slide';

const POLL_MS = 2_000; // Between fetches

const GIVE_UP_MS = 30 * 60 * 1000; // Stop polling after half an hour, well before the
// claim cookie expires at 60 min

function mountClaimPoll(): void {
  const link = document.querySelector<HTMLAnchorElement>('[data-spr-setup-refresh]');

  // Not on the claim page
  if (!link) return;

  const startedAt = Date.now();
  let timer = 0;

  const tick = async (): Promise<void> => {
    if (Date.now() - startedAt > GIVE_UP_MS) return;
    try {
      const response = await fetch('/api/setup/claim', {
        headers: { Accept: 'application/json' },

        credentials: 'same-origin',
      });
      if (response.ok) {
        const body = (await response.json()) as { status?: string };

        if (body.status === 'approved' || body.status === 'gone') {
          window.location.assign('/');
          return;
        }
      }
    } catch {
      // Transient network errors are swallowed so the next cycle retries
    }
    timer = window.setTimeout(() => void tick(), POLL_MS);
  };

  timer = window.setTimeout(() => void tick(), POLL_MS);

  // Pause while the tab is hidden to save resources; restart when visible
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      window.clearTimeout(timer);
    } else {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void tick(), POLL_MS);
    }
  });
}

mountClaimPoll();
mountCopy();
mountNav();
mountRepositoryStep();
// The walkthrough of the repositories page
mountModals();
mountWalkthroughs();
