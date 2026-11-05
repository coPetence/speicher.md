/** Enter in a text field of an add modal goes to the next one; the last one submits the modal */
export function mountEnterNextField(): void {
  for (const panel of document.querySelectorAll<HTMLElement>('.spr-add-panel')) {
    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented) return;

      const control = event.target;
      if (!(control instanceof HTMLInputElement) || control.type !== 'text') return;

      const fields = [...panel.querySelectorAll<HTMLInputElement>('input[type="text"]')].filter(
        (field) => !field.closest('[hidden]'),
      );
      const next = fields[fields.indexOf(control) + 1];
      if (!next) return;

      event.preventDefault();
      next.focus();
    });
  }
}
