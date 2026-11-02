/** Show field errors from JSON checks, replacing existing server or client errors */

import { linked } from './check-verdict-wording';

/** Check error with a form field path */
export interface FieldProblem {
  code: string;
  text: string;
  path: string | null;
}

const INVALID = 'spr-field-invalid';
const NOTE = 'spr-field-problem';

/** Find the field control within this form */
function controlOf(form: HTMLFormElement, path: string): HTMLElement | null {
  const control = form.ownerDocument.getElementById(`f-${path}`);
  return control && form.contains(control) ? control : null;
}

/** Get the field label without the required marker */
export function fieldLabel(form: HTMLFormElement, path: string): string | null {
  const label = [...form.querySelectorAll('label')].find((each) => each.htmlFor === `f-${path}`);
  const words = label?.childNodes[0]?.textContent?.trim();
  return words ? words : null;
}

const ADD_MEMBERS_MODAL = '.spr-add-row-dialog';

/** Clear server and client field errors */
export function clearFieldProblems(form: HTMLFormElement): void {
  const page = (element: Element) => !element.closest(ADD_MEMBERS_MODAL);
  for (const note of [...form.querySelectorAll(`.${NOTE}`)].filter(page)) note.remove();
  for (const field of form.querySelectorAll(`.${INVALID}`)) {
    field.classList.remove(INVALID);
    field.removeAttribute('data-spr-problem');
  }
  for (const control of [...form.querySelectorAll('[aria-invalid="true"]')].filter(page)) {
    control.removeAttribute('aria-invalid');
    control.removeAttribute('aria-describedby');
  }
}

/** Mark field errors and return problems with no matching field */
export function markFieldProblems(form: HTMLFormElement, problems: FieldProblem[]): FieldProblem[] {
  clearFieldProblems(form);
  const unmarked: FieldProblem[] = [];
  for (const problem of problems) {
    const control = problem.path === null ? null : controlOf(form, problem.path);
    const field = control?.closest('.spr-field, .spr-row-edit-field');
    if (!control || !field || problem.path === null) {
      unmarked.push(problem);
      continue;
    }
    field.classList.add(INVALID);
    field.setAttribute('data-spr-problem', problem.code);

    const id = `f-${problem.path}-problem`;
    control.setAttribute('aria-invalid', 'true');
    control.setAttribute('aria-describedby', id);

    const note = form.ownerDocument.createElement('p');
    note.className = NOTE;
    note.id = id;
    note.replaceChildren(...linked(problem.text));
    // Place the note after the control or its select wrapper
    (control.closest('.spr-select') ?? control).after(note);
  }
  return unmarked;
}
