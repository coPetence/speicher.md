/** `data-spr-suggests`: proposes a name until somebody types one of their own. */

export function mountSuggestions(): void {
  // Fill a text input from a select or button only if the user has not typed in it
  for (const source of document.querySelectorAll<HTMLElement>('[data-spr-suggests]')) {
    const target = document.getElementById(source.dataset.sprSuggests ?? '');
    if (!(target instanceof HTMLInputElement)) continue;

    let offered = target.value;
    source.addEventListener('change', (event) => {
      const picked = event.target;
      const suggestion =
        picked instanceof HTMLSelectElement
          ? (picked.selectedOptions[0]?.dataset.sprSuggest ?? '')
          : picked instanceof HTMLElement
            ? (picked.dataset.sprSuggest ?? '')
            : '';
      if (suggestion === '' || target.value !== offered) return;
      target.value = suggestion;
      offered = suggestion;
    });
  }
}
