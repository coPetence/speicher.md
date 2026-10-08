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
 * A problem is held back until Save is first pressed, so a page reached by Add does
 * not open on an error; from then on it is shown as it changes. Server-rendered
 * `data-spr-attempted` marks a page that came back from a refused submission
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
const ATTEMPTED = 'data-spr-attempted'; // A submission was refused, so problems are shown
const DEBOUNCE_MS = 400; // Delay before checking after input stops
const SLOW_CHECK_MS = 100; // Show "Checking…" if server takes longer than this

export function mountConfigBar(): void {
  const form = configForm();
  if (!form) return;

  const save = form.querySelector<HTMLButtonElement>('.spr-config-save');
  const actions = form.querySelector<HTMLElement>('.spr-config-actions');
  if (!save || !actions) return;

  form.setAttribute(LIVE, '');

  // The bar floats at the foot of the window but lines up with the form, whose
  // edges only the browser can measure, reaching past them by --spr-bar-reach
  const align = (): void => {
    const box = form.getBoundingClientRect();
    actions.style.left = `calc(${box.left}px - var(--spr-bar-reach))`;
    actions.style.width = `calc(${box.width}px + 2 * var(--spr-bar-reach))`;
  };
  align();
  addEventListener('resize', align);
  if ('ResizeObserver' in window) new ResizeObserver(align).observe(form);

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

  let attempted = form.hasAttribute(ATTEMPTED); // Save has been pressed, so problems are shown
  let problem: string | null = null; // What the latest check found wrong, shown or not

  const isPending = (): boolean => serverPending || snapshot(form) !== baseline;

  const wouldLoseWork = (): boolean => serverHoldsWork || snapshot(form) !== baseline;

  const say = (state: string, text: string): void => {
    form.setAttribute(STATE, state);
    status.textContent = text;
  };

  const refuse = (text: string): void => {
    problem = text;
    if (!attempted) {
      save.disabled = false;
      say('pending', UNSAVED);
      return;
    }
    save.disabled = true;
    say('invalid', text);
  };

  const check = async (): Promise<void> => {
    inFlight?.abort();

    if (!form.checkValidity()) {
      refuse(constraintProblem(form));
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
        const detail = plain(payload.problems?.[0]);
        const headline = payload.error ?? 'This configuration would not load.';
        refuse(detail ? `${headline}: ${detail}` : headline);
        return;
      }

      problem = null;
      save.disabled = false;
      say('ready', describe(payload.verdict));
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      if (controller !== inFlight) return;

      problem = null;
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
    // What the last check found may just have been fixed; the next check says
    problem = null;
    update();
  };

  form.addEventListener('input', touch);
  form.addEventListener('change', touch);

  // The first press of Save shows what is held back. A known problem stops the save;
  save.addEventListener('click', (event) => {
    if (attempted) return;
    attempted = true;
    if (!form.checkValidity()) {
      refuse(constraintProblem(form));
      return;
    }
    if (problem === null) return;
    event.preventDefault();
    refuse(problem);
  });

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
