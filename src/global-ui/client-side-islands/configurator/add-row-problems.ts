const PROBLEM = '.spr-field-problem';

export function mountRowAddProblems(): void {
  for (const dialog of document.querySelectorAll<HTMLElement>('.spr-add-row-dialog')) {
    const clear = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element) || target.matches('[data-spr-option-search]')) return;

      const matches = target.closest('.spr-add-row-matches');
      if (matches) {
        matches.querySelector(PROBLEM)?.remove();
        target.removeAttribute('aria-invalid');
        target.removeAttribute('aria-describedby');
        return;
      }
      target.closest('.spr-add-row-panel')?.querySelector(`:scope > ${PROBLEM}`)?.remove();
    };
    dialog.addEventListener('input', clear);
    dialog.addEventListener('change', clear);
  }
}
