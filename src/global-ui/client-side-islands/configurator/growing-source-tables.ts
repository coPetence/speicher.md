import { configForm, reportScriptedEdit } from './config-form-handle';

const SHAPE_PREFIX = '__shape:'; // Prefix for the hidden input that records the shape of a collection

export function mountGrowingTables(): void {
  // Tables that add a row when the trailing empty one is typed into
  //
  // A collection can span multiple tables differentiated by `data-spr-kind`; positions
  // are numbered across all of them via `data-spr-position` on each row
  // The shape (which kind occupies each position) is kept in a hidden `__shape:collection`
  // input so the server knows what each position represents
  //
  // Deletions are handled locally when the page owns the full 0..N range of the
  // collection, else stored-row deletions submit to the server
  // Not debouncing input to avoid a delay between typing and row creation

  const form = configForm();
  if (!form) return;

  const tables = [...form.querySelectorAll<HTMLTableElement>('table[data-spr-grow]')];
  if (tables.length === 0) return;

  const rowsOnPage = (): HTMLTableRowElement[] =>
    Array.from(form.querySelectorAll<HTMLTableRowElement>('tr[data-spr-position]'));

  const positionOf = (row: HTMLElement): number => Number(row.dataset.sprPosition);
  const kindOf = (row: HTMLElement): string =>
    row.closest<HTMLElement>('table[data-spr-grow]')?.dataset.sprKind ?? '';

  const inOrder = (): HTMLTableRowElement[] =>
    rowsOnPage().sort((a, b) => positionOf(a) - positionOf(b));

  const layout = (): string =>
    inOrder()
      .map((row) => `${positionOf(row)}:${kindOf(row)}`)
      .join(',');

  const arrival = layout(); // Snapshot of the layout at mount, used to detect changes
  const shapes = new Map<string, string>(); // Collection name to shape value from hidden input
  for (const table of tables) {
    const collection = table.dataset.sprGrow;
    if (collection === undefined) continue;
    const control = form.querySelector<HTMLInputElement>(
      `input[name="${SHAPE_PREFIX}${collection}"]`,
    );
    if (control) shapes.set(collection, control.value);
  }

  const kindsOf = (shape: string): string[] => (shape === '' ? [] : shape.split(','));

  const slots = rowsOnPage()
    .map(positionOf)
    .sort((a, b) => a - b);
  const slotAt = (index: number): number =>
    index < slots.length ? slots[index] : slots[slots.length - 1] + 1 + index - slots.length;

  const ownsCollection = [...shapes.values()].every((shape) =>
    kindsOf(shape).every((_, index) => slots[index] === index),
  ); // True when the page has positions 0..N of every collection

  const renumber = (row: HTMLElement, to: number): void => {
    const from = positionOf(row);
    if (from === to) return;
    row.dataset.sprPosition = String(to);
    for (const control of row.querySelectorAll<HTMLInputElement>('input[name]')) {
      control.name = control.name.replace(`.${from}.`, `.${to}.`);
      if (control.id) control.id = control.id.replace(`.${from}.`, `.${to}.`);
    }

    const box = row.querySelector<HTMLInputElement>('input[name="select"]');
    if (box) box.value = box.value.replace(new RegExp(`\\.${from}$`), `.${to}`);
  };

  const resync = (): void => {
    // Renumber all rows in order, then update the shape for each collection
    inOrder().forEach((row, index) => renumber(row, slotAt(index)));

    const settled = layout() === arrival;
    const rows = inOrder();
    const highest = rows.length === 0 ? -1 : positionOf(rows[rows.length - 1]);
    for (const [collection, original] of shapes) {
      const control = form.querySelector<HTMLInputElement>(
        `input[name="${SHAPE_PREFIX}${collection}"]`,
      );
      if (!control) continue;
      const kinds = kindsOf(original);
      for (const row of rows) kinds[positionOf(row)] = kindOf(row);

      kinds.length = ownsCollection ? highest + 1 : Math.max(kinds.length, highest + 1);
      control.value = settled ? original : kinds.join(',');
    }

    reportScriptedEdit(form);
  };

  const selectable = (row: HTMLElement, shown: boolean): void => {
    // Ensure the row has a checkbox for bulk selection
    // `shown` true removes the idle marker, false hides the checkbox
    let box = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!box) {
      box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.sprUnsaved = '';
      box.setAttribute('aria-label', 'Select this unsaved row');
      row.querySelector('td')?.prepend(box);
    }
    if (shown) delete box.dataset.sprIdle;
    else box.dataset.sprIdle = '';
  };

  for (const row of rowsOnPage()) {
    if (!row.querySelector('input[name="select"]')) selectable(row, false);
  }

  const filled = (row: HTMLElement): boolean =>
    Array.from(row.querySelectorAll<HTMLInputElement>('input[type="text"]')).some(
      (box) => box.value.trim() !== '',
    );

  const grow = (table: HTMLTableElement): void => {
    // Clone the trailing row when it has been typed into
    const body = table.tBodies[0];
    const last = body?.querySelector<HTMLTableRowElement>('tr[data-spr-trailing]');
    if (!body || !last || !filled(last)) return;

    const fresh = last.cloneNode(true) as HTMLTableRowElement;
    for (const control of fresh.querySelectorAll<HTMLInputElement>('input[type="text"]')) {
      control.value = '';
    }

    selectable(fresh, false);

    last.removeAttribute('data-spr-trailing');
    selectable(last, true);

    body.append(fresh);
    resync();
  };

  form.addEventListener('input', (event) => {
    const table = (event.target as HTMLElement | null)?.closest<HTMLTableElement>(
      'table[data-spr-grow]',
    );
    if (table) grow(table);
  });

  form.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
      'button[name="op"]',
    );
    if (!button || !button.value.startsWith('remove-selected:')) return;

    const picked = rowsOnPage().filter((row) =>
      row.querySelector<HTMLInputElement>('input[type="checkbox"]:checked'),
    );

    if (picked.length === 0) {
      event.preventDefault();
      return;
    }

    const stored = picked.some((row) => row.querySelector('input[name="select"]'));
    if (stored && !ownsCollection) return; // Let the server handle deletion of stored rows

    event.preventDefault();

    for (const row of picked) row.remove();
    resync();
  });
}
