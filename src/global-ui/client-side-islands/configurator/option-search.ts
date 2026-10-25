/**
 * A search box over a list of options
 */

export function mountOptionSearches(): void {
  for (const list of document.querySelectorAll<HTMLElement>('[data-spr-option-list]')) {
    const search = list.querySelector<HTMLInputElement>('[data-spr-option-search]');
    if (!search) continue;
    const narrow = (): void => {
      const needle = search.value.trim().toLowerCase();
      for (const label of list.querySelectorAll<HTMLElement>('label[data-spr-option]')) {
        label.hidden = needle !== '' && !(label.dataset.sprOption ?? '').includes(needle);
      }
    };
    search.addEventListener('input', narrow);
    narrow();
  }
}
