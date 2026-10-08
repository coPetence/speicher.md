/**
 * Client-side live filter on tabular views
 *
 * Hides table rows whose `data-spr-row` doesn't contain the typed text
 * Toggles empty-state sections and the scroll container around the table
 * Not mounted when the server already rendered a filtered view — the
 * input's value is non-empty and the initial page is correct
 *
 * The `search` event fires when the browser clears the field
 */

const LIVE = 'data-spr-live';

export function mountFilter(tableSelector: string): void {
  const form = document.querySelector<HTMLFormElement>('form[data-spr-filter]');
  if (!form) return;

  const box = form.querySelector<HTMLInputElement>('input[name="q"]');
  const table = document.querySelector<HTMLElement>(tableSelector);
  if (!box || !table) return;

  if (box.value.trim() !== '') return;

  const rows = [...table.querySelectorAll<HTMLElement>('tr[data-spr-row]')];
  const scroll = table.closest<HTMLElement>('.spr-scroll') ?? table;

  const emptyNone = document.querySelector<HTMLElement>('[data-spr-empty="none"]');
  const emptyFiltered = document.querySelector<HTMLElement>('[data-spr-empty="filtered"]');
  const needleSlot = emptyFiltered?.querySelector<HTMLElement>('[data-spr-needle]');

  form.setAttribute(LIVE, '');

  const apply = (): void => {
    const typed = box.value.trim();
    const needle = typed.toLowerCase();
    let shown = 0;
    for (const row of rows) {
      const hit = needle === '' || (row.dataset.sprRow ?? '').includes(needle);
      row.hidden = !hit;
      if (hit) shown++;
    }

    scroll.hidden = shown === 0;

    if (needleSlot) needleSlot.textContent = typed;
    if (emptyNone) emptyNone.hidden = shown > 0 || needle !== '';
    if (emptyFiltered) emptyFiltered.hidden = shown > 0 || needle === '';
  };

  form.addEventListener('input', apply);

  box.addEventListener('search', apply);

  apply();
}
