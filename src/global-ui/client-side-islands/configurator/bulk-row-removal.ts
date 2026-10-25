import { configForm, reportScriptedEdit } from './config-form-handle';

const SHAPE_PREFIX = '__shape:'; // Prefix for the hidden input that records the shape of a collection

export function mountBulkRowRemoval(): void {
  const form = configForm();
  if (!form) return;

  const lists = [...form.querySelectorAll<HTMLElement>('[data-spr-rows]')];
  if (lists.length === 0) return;

  const positionOf = (row: HTMLElement): number => Number(row.dataset.sprPosition);

  const rowsOf = (list: HTMLElement): HTMLElement[] =>
    Array.from(list.querySelectorAll<HTMLElement>('[data-spr-position]')).sort(
      (a, b) => positionOf(a) - positionOf(b),
    );

  const renumber = (row: HTMLElement, to: number): void => {
    const from = positionOf(row);
    if (from === to) return;
    row.dataset.sprPosition = String(to);
    const moved = (value: string) => value.replace(`.${from}.`, `.${to}.`);
    for (const control of row.querySelectorAll<HTMLElement>('[name]')) {
      control.setAttribute('name', moved(control.getAttribute('name') ?? ''));
    }
    for (const control of row.querySelectorAll<HTMLElement>('[id]')) control.id = moved(control.id);
    for (const label of row.querySelectorAll<HTMLLabelElement>('label[for]')) {
      label.htmlFor = moved(label.htmlFor);
    }
    for (const control of row.querySelectorAll<HTMLElement>('[aria-describedby]')) {
      control.setAttribute(
        'aria-describedby',
        moved(control.getAttribute('aria-describedby') ?? ''),
      );
    }

    const box = row.querySelector<HTMLInputElement>('input[name="select"]');
    if (box) box.value = box.value.replace(new RegExp(`\\.${from}$`), `.${to}`);
  };

  const resync = (list: HTMLElement): void => {
    const rows = rowsOf(list);
    rows.forEach((row, index) => renumber(row, index));

    const shape = form.querySelector<HTMLInputElement>(
      `input[name="${SHAPE_PREFIX}${list.dataset.sprRows}"]`,
    );
    if (shape) shape.value = rows.map((row) => row.dataset.sprKind ?? '').join(',');

    // The last row gone, the page looks as the server draws a list with none: the
    // empty state with the Add control under it, and no field that needs a row
    if (rows.length === 0) {
      const collection = list.dataset.sprRows ?? '';
      const empty = form.querySelector<HTMLElement>(`[data-spr-rows-empty="${collection}"]`);
      empty?.removeAttribute('hidden');
      const add = form.querySelector<HTMLElement>(`[data-spr-rows-add="${collection}"]`);
      if (empty && add) empty.append(add);
      for (const field of form.querySelectorAll<HTMLElement>(
        `[data-spr-shown-with-rows="${collection}"]`,
      )) {
        field.hidden = true;
      }
    }

    reportScriptedEdit(form);
  };

  form.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
      'button[name="op"]',
    );
    if (!button || !button.value.startsWith('remove-selected:')) return;

    const list = lists.find(
      (candidate) => `remove-selected:${candidate.dataset.sprRows}` === button.value,
    );
    if (!list) return;

    event.preventDefault();

    const picked = rowsOf(list).filter((row) =>
      row.querySelector<HTMLInputElement>('input[name="select"]:checked'),
    );
    if (picked.length === 0) return;

    for (const row of picked) row.remove();
    resync(list);
  });
}
