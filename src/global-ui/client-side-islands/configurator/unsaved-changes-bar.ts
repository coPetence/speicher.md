/**
 * Track unsaved changes and debounce validation
 * Show problems after a save attempt
 */

import { configForm } from './config-form-handle';
import { CheckAnswer, UNSAVED, constraintProblem, describe, linked } from './check-verdict-wording';
import { FieldProblem, clearFieldProblems, fieldLabel, markFieldProblems } from './field-problems';
import { snapshot } from './form-change-snapshot';

const PENDING = 'data-spr-pending'; // Unsaved changes
const HOLDS_WORK = 'data-spr-holds-work'; // Server work lost on navigation
const LIVE = 'data-spr-live'; // JS active
const STATE = 'data-spr-check'; // CSS validation state
const ATTEMPTED = 'data-spr-attempted'; // Show validation problems
const DEBOUNCE_MS = 400; // Input debounce
const SLOW_CHECK_MS = 100; // Delay checking indicator

export function mountConfigBar(): void {
  const form = configForm();
  if (!form) return;

  const save = form.querySelector<HTMLButtonElement>('.spr-config-save');
  const actions = form.querySelector<HTMLElement>('.spr-config-actions');
  if (!save || !actions) return;

  form.setAttribute(LIVE, '');

  // Align the floating bar with the form, extending by --spr-bar-reach
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

  let attempted = form.hasAttribute(ATTEMPTED); // Show problems after a save attempt
  let problem: string | null = null; // Latest problem, possibly hidden

  const isPending = (): boolean => serverPending || snapshot(form) !== baseline;

  const wouldLoseWork = (): boolean => serverHoldsWork || snapshot(form) !== baseline;

  const say = (state: string, text: string): void => {
    form.setAttribute(STATE, state);
    // Link to problem locations
    status.replaceChildren(...linked(text));
  };

  // Latest problems; mark fields after a save attempt
  let found: FieldProblem[] = [];

  const refuse = (text: string): void => {
    problem = text;
    if (!attempted) {
      save.disabled = false;
      say('pending', UNSAVED);
      return;
    }
    save.disabled = true;
    markFieldProblems(form, found);
    say('invalid', text);
  };

  // Summarize the first problem with its field label and remaining count
  const refusalOf = (payload: CheckAnswer): string => {
    const texts = payload.problems ?? [];
    found = texts.length
      ? texts.map((text, i) => ({
          text,
          code: payload.problem_codes?.[i] ?? '',
          path: payload.problem_paths?.[i] ?? null,
        }))
      : payload.error
        ? [
            {
              text: payload.error,
              code: payload.error_code ?? '',
              path: payload.error_path ?? null,
            },
          ]
        : [];
    const [first] = found;
    if (!first) return payload.error ?? 'This configuration would not load.';
    const label = first.path === null ? null : fieldLabel(form, first.path);
    const more = found.length > 1 ? ` (${found.length - 1} more)` : '';
    if (label && first.code === 'schema.required') return `The field ${label} is required${more}`;
    return `${label ? `${label}: ` : ''}${first.text}${more}`;
  };

  const check = async (): Promise<void> => {
    inFlight?.abort();

    if (!form.checkValidity()) {
      found = [];
      refuse(constraintProblem(form));
      return;
    }

    const controller = new AbortController();
    inFlight = controller;

    // Delay the indicator; ignore stale requests
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

      // Ignore stale responses
      if (controller !== inFlight) return;

      const payload = (await response.json()) as CheckAnswer;

      if (!response.ok) {
        refuse(refusalOf(payload));
        return;
      }

      problem = null;
      found = [];
      clearFieldProblems(form);
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
    // Clear the previous problem until rechecked
    problem = null;
    update();
  };

  form.addEventListener('input', touch);
  form.addEventListener('change', touch);

  // First save attempt shows problems and blocks known failures
  save.addEventListener('click', (event) => {
    if (attempted) return;
    attempted = true;
    if (!form.checkValidity()) {
      found = [];
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

  // Reset state after back/forward cache restoration
  addEventListener('pageshow', (event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    submitting = false;
    baseline = snapshot(form);
    update();
  });
}
