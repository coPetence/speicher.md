/**
 * Unsaved changes bar on configuration forms
 *
 * Tracks form changes via snapshot comparison, runs debounced server-side checks
 * The form gets `data-spr-live` once JS attaches, `data-spr-pending` on change
 * `data-spr-check` holds the status state for CSS: pending, invalid, checking, ready
 *
 * Server-rendered `data-spr-pending` carries over if the session has unsaved changes
 * `data-spr-holds-work` warns that navigating away would lose server-side changes
 *
 * Not checked on every keystroke: debounced at 400ms
 */

import { configForm } from './config-form-handle';
import { CheckAnswer, UNSAVED, constraintProblem, describe, plain } from './check-verdict-wording';
import { snapshot } from './form-change-snapshot';

const PENDING = 'data-spr-pending'; // Form has unsaved changes
const HOLDS_WORK = 'data-spr-holds-work'; // Server-side changes would be lost on navigate
const LIVE = 'data-spr-live'; // JS is attached to this form
const STATE = 'data-spr-check'; // Status state for CSS: pending, invalid, checking, ready
const DEBOUNCE_MS = 400; // Delay before checking after input stops
const SLOW_CHECK_MS = 100; // Show "Checking…" if server takes longer than this

export function mountConfigBar(): void {
  const form = configForm();
  if (!form) return;

  const save = form.querySelector<HTMLButtonElement>('.spr-config-save');
  const actions = form.querySelector<HTMLElement>('.spr-config-actions');
  if (!save || !actions) return;

  form.setAttribute(LIVE, '');

  const status = document.createElement('p');
  status.className = 'spr-config-state';
  status.setAttribute('role', 'status');
  actions.insertBefore(status, actions.firstChild);

  const serverPending = form.hasAttribute(PENDING);
  const serverHoldsWork = form.hasAttribute(HOLDS_WORK);
  let baseline = snapshot(form);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | undefined;
  let submitting = false;

  let touched = false; // Don't show validation errors before the user has interacted

  const isPending = (): boolean => serverPending || snapshot(form) !== baseline;

  const wouldLoseWork = (): boolean => serverHoldsWork || snapshot(form) !== baseline;

  const say = (state: string, text: string): void => {
    form.setAttribute(STATE, state);
    status.textContent = text;
  };

  const check = async (): Promise<void> => {
    inFlight?.abort();

    if (!form.checkValidity()) {
      if (!touched) {
        say('pending', UNSAVED);
        return;
      }
      save.disabled = true;
      say('invalid', constraintProblem(form));
      return;
    }

    const controller = new AbortController();
    inFlight = controller;

    // Show "Checking…" after SLOW_CHECK_MS only if this request is still current
    const slow = setTimeout(() => {
      if (controller === inFlight) say('checking', 'Checking…');
    }, SLOW_CHECK_MS);

    const body = new FormData(form);
    body.append('intent', 'check');

    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body,
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
      });

      // A newer check was scheduled; discard this stale response
      if (controller !== inFlight) return;

      const payload = (await response.json()) as CheckAnswer;

      if (!response.ok) {
        save.disabled = true;
        const detail = plain(payload.problems?.[0]);
        const headline = payload.error ?? 'This configuration would not load.';
        say('invalid', detail ? `${headline} — ${detail}` : headline);
        return;
      }

      save.disabled = false;
      say('ready', describe(payload.verdict));
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      if (controller !== inFlight) return;

      save.disabled = false;
      say('ready', `${UNSAVED} Could not check them from here — Save will.`);
    } finally {
      clearTimeout(slow);
    }
  };

  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void check(), DEBOUNCE_MS);
  };

  const update = (): void => {
    if (!isPending()) {
      form.removeAttribute(PENDING);
      form.removeAttribute(STATE);
      inFlight?.abort();
      inFlight = undefined;
      clearTimeout(timer);
      save.disabled = false;
      status.textContent = '';
      return;
    }
    form.setAttribute(PENDING, '');
    if (status.textContent === '') say('pending', UNSAVED);
    schedule();
  };

  const touch = (): void => {
    touched = true;
    update();
  };

  form.addEventListener('input', touch);
  form.addEventListener('change', touch);

  form.addEventListener('submit', () => {
    submitting = true;
  });

  addEventListener('beforeunload', (event) => {
    if (submitting || !wouldLoseWork()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  if (serverPending) update();

  // Reset state on back/forward cache restore
  addEventListener('pageshow', (event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    submitting = false;
    baseline = snapshot(form);
    update();
  });
}
