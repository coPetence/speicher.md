import { configForm, reportScriptedEdit } from './config-form-handle';

/**
 * Looks up the embedding vector width on model change
 *
 * The embedding config form has model-name inputs marked with
 * data-spr-width-into pointing to the dimensions input they feed.
 * When the model name changes (change event), the server is asked
 * what width its vectors are.  If the dimensions input is empty or
 * was filled by this script, the answer is written into it.
 * A value typed by hand is kept; clearing it re-asks the model.
 */

/** Mounts width lookups on model inputs with data-spr-width-into */
export function mountWidths(): void {
  const form = configForm();
  if (!form) return;

  for (const model of form.querySelectorAll<HTMLInputElement>('input[data-spr-width-into]')) {
    const target = form.querySelector<HTMLInputElement>(
      `input[name="${model.dataset.sprWidthInto ?? ''}"]`,
    );
    const note = model.closest('.spr-field')?.querySelector<HTMLElement>('[data-spr-width-note]');
    if (!target || !note) continue;

    // Last model name asked; skips duplicate change events
    let asked = model.value.trim();

    // Ticket counter; discards stale responses from earlier requests
    let latest = 0;

    // Last value the target held; detects when the user clears it
    let held = target.value.trim();

    // Value this script last wrote to the target; keeps hand edits
    let written: string | null = null;

    const say = (level: string, text: string): void => {
      note.className = `spr-note spr-note-${level}`;
      note.textContent = text;
      note.hidden = false;
    };

    const ask = (): void => {
      const name = model.value.trim();
      if (name === '') return;
      asked = name;

      const ticket = ++latest;
      say('idle', 'Asking the endpoint for the width of this model…');

      // Fire-and-forget fetch; the ticket check discards responses once a
      // newer request has been made
      void (async () => {
        try {
          const body = new FormData(form);
          body.append('intent', 'width');

          const response = await fetch(form.action, {
            method: 'POST',
            body,
            headers: { Accept: 'application/json' },
            credentials: 'same-origin',
          });
          const payload = (await response.json()) as { dimensions?: number; error?: string };
          if (ticket !== latest) return;

          if (!response.ok || typeof payload.dimensions !== 'number') {
            say('fail', payload.error ?? 'The endpoint did not answer.');
            return;
          }

          const width = payload.dimensions;
          const current = target.value.trim();
          // Writes into an empty target or one the script last filled
          // A hand-typed value is never overwritten
          if (current === '' || target.value === written) {
            target.value = String(width);
            written = target.value;
            held = written;

            // Fires form-level listeners so the unsaved-changes bar reacts
            reportScriptedEdit(form);
            say(
              'ok',
              `This model returns ${width}-dimensional vectors, so Dimensions is ${width}.`,
            );
          } else if (current === String(width)) {
            say(
              'ok',
              `This model returns ${width}-dimensional vectors, which is what Dimensions holds.`,
            );
          } else {
            say(
              'warn',
              `This model returns ${width}-dimensional vectors. Dimensions holds ${current}, typed by hand, so it stays. Clear Dimensions to take ${width}.`,
            );
          }
        } catch {
          if (ticket === latest)
            say('fail', 'Could not ask the server. Enter the dimensions by hand.');
        }
      })();
    };

    model.addEventListener('change', () => {
      if (model.value.trim() === asked) return;
      ask();
    });

    // Re-asks the model when the user clears the dimensions input so they
    // can get the auto-fill back after a hand edit
    target.addEventListener('input', () => {
      const now = target.value.trim();
      const emptied = now === '' && held !== '';
      held = now;
      if (emptied) ask();
    });
  }
}
