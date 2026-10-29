import { configForm, reportScriptedEdit } from './config-form-handle';

interface Parts {
  list: HTMLUListElement;
  empty: HTMLElement;
  rowTemplate: HTMLTemplateElement;
  choiceTemplate: HTMLTemplateElement;
  modal: HTMLDetailsElement;
  choices: HTMLFieldSetElement;
  search: HTMLInputElement;
  none: HTMLElement;
}

export function mountPickLists(): void {
  const form = configForm();
  if (!form) return;

  // A choice the address names, e.g. from the repositories page: its dialog opens with it ticked
  const picked = new URLSearchParams(window.location.search).get('pick')?.toLowerCase();
  for (const field of Array.from(form.querySelectorAll<HTMLElement>('.spr-field-pick-list'))) {
    const parts = partsOf(field);
    if (!parts) continue;
    parts.search.hidden = false;
    field.querySelector<HTMLElement>('[data-spr-pick-cancel]')?.removeAttribute('hidden');
    parts.modal.addEventListener('toggle', () => {
      if (!parts.modal.open) reset(parts);
    });
    const choice = choicesOf(parts).find((each) => each.dataset.sprPickChoice === picked);
    const box = choice?.querySelector<HTMLInputElement>('input');
    if (box) {
      box.checked = true;
      parts.modal.open = true;
    }
  }

  form.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const parts = partsOf(target?.closest<HTMLElement>('.spr-field-pick-list') ?? null);
    if (!parts) return;

    if (target?.closest('button[data-spr-pick-add]')) {
      event.preventDefault();
      addTicked(parts);
      return;
    }
    if (target?.closest('button[data-spr-pick-cancel]')) {
      event.preventDefault();
      parts.modal.open = false;
      return;
    }
    const remove = target?.closest<HTMLButtonElement>('button[name^="remove:"]');
    if (remove) {
      event.preventDefault();
      removeRow(parts, remove);
    }
  });

  form.addEventListener('input', (event) => {
    const search = event.target as HTMLElement | null;
    if (!search?.matches('[data-spr-pick-search]')) return;
    const parts = partsOf(search.closest<HTMLElement>('.spr-field-pick-list'));
    if (parts) narrow(parts);
  });
}

function partsOf(field: HTMLElement | null): Parts | null {
  const find = <T extends Element>(selector: string) => field?.querySelector<T>(selector) ?? null;
  const parts = {
    list: find<HTMLUListElement>('ul.spr-pick-list'),
    empty: find<HTMLElement>('.spr-pick-list-empty'),
    rowTemplate: find<HTMLTemplateElement>('template[data-spr-pick-row]'),
    choiceTemplate: find<HTMLTemplateElement>('template[data-spr-pick-choice]'),
    modal: find<HTMLDetailsElement>('details.spr-pick-list-modal'),
    choices: find<HTMLFieldSetElement>('.spr-pick-list-choices'),
    search: find<HTMLInputElement>('[data-spr-pick-search]'),
    none: find<HTMLElement>('.spr-pick-list-none'),
  };
  return Object.values(parts).every((part) => part !== null) ? (parts as Parts) : null;
}

const choicesOf = (parts: Parts): HTMLLabelElement[] =>
  Array.from(parts.choices.querySelectorAll<HTMLLabelElement>('label[data-spr-pick-choice]'));

function narrow(parts: Parts): void {
  const needle = parts.search.value.trim().toLowerCase();
  let shown = 0;
  for (const choice of choicesOf(parts)) {
    choice.hidden = !(choice.dataset.sprPickChoice ?? '').includes(needle);
    if (!choice.hidden) shown += 1;
  }
  parts.none.hidden = shown > 0;
}

function reset(parts: Parts): void {
  for (const box of Array.from(parts.choices.querySelectorAll<HTMLInputElement>('input'))) {
    box.checked = false;
  }
  parts.search.value = '';
  narrow(parts);
}

function addTicked(parts: Parts): void {
  const ticked = choicesOf(parts).filter(
    (choice) => choice.querySelector<HTMLInputElement>('input')?.checked,
  );
  if (ticked.length === 0) {
    parts.search.focus();
    return;
  }

  for (const choice of ticked) {
    const row = parts.rowTemplate.content.firstElementChild?.cloneNode(true) as HTMLLIElement;
    const value = choice.querySelector<HTMLInputElement>('input')?.value ?? '';
    const input = row.querySelector<HTMLInputElement>('input[type="hidden"]');
    const button = row.querySelector<HTMLButtonElement>('button');
    if (input) input.value = value;
    if (button) {
      button.value = value;
      button.setAttribute('aria-label', `Remove ${value}`);
    }
    swapValue(choice, row);
    parts.list.append(row);
    choice.remove();
  }

  parts.modal.open = false;
  settle(parts);
}

function removeRow(parts: Parts, button: HTMLButtonElement): void {
  const row = button.closest('li');
  if (!row) return;

  if (row.hasAttribute('data-spr-offered')) {
    const choice = parts.choiceTemplate.content.firstElementChild?.cloneNode(
      true,
    ) as HTMLLabelElement;
    const box = choice.querySelector<HTMLInputElement>('input');
    if (box) box.value = button.value;
    choice.dataset.sprPickChoice = button.value.toLowerCase();
    swapValue(row, choice);
    const next = choicesOf(parts).find(
      (each) => (each.dataset.sprPickChoice ?? '').localeCompare(button.value.toLowerCase()) > 0,
    );
    parts.choices.insertBefore(choice, next ?? null);
  }

  row.remove();
  settle(parts);
}

// Moves the name and its note from one element to the other
function swapValue(from: Element, to: Element): void {
  const source = from.querySelector('.spr-pick-list-value');
  const target = to.querySelector('.spr-pick-list-value');
  if (source && target) target.replaceChildren(...Array.from(source.childNodes));
}

function settle(parts: Parts): void {
  const rows = parts.list.children.length;
  parts.list.hidden = rows === 0;
  parts.empty.hidden = rows !== 0;
  parts.modal.hidden = choicesOf(parts).length === 0;
  // In the dialog's place while there is nothing to add, saying why
  const unavailable = parts.modal.parentElement?.querySelector<HTMLElement>(
    '.spr-pick-list-unavailable',
  );
  if (unavailable) unavailable.hidden = !parts.modal.hidden;
  narrow(parts);
  reportScriptedEdit(parts.list);
}
