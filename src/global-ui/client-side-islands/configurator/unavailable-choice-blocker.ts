/** Disables a modal's submit while an option marked `data-spr-unavailable` is chosen. */

export function mountBlockedAnswers(): void {
  // Disable the submit button when an unavailable option is selected
  for (const group of document.querySelectorAll<HTMLElement>('.spr-choices')) {
    const blocked = Array.from(
      group.querySelectorAll<HTMLInputElement | HTMLOptionElement>('[data-spr-unavailable]'),
    );
    if (blocked.length === 0) continue;

    const submit = group.closest('.spr-modal-panel')?.querySelector('button[type="submit"]');
    if (!(submit instanceof HTMLButtonElement)) continue;

    const settle = (): void => {
      submit.disabled = blocked.some((control) =>
        control instanceof HTMLOptionElement ? control.selected : control.checked,
      );
    };
    group.addEventListener('change', settle);
    settle();
  }
}
