/**
 * Dropdown keyboard and mouse behaviour for picture-picker selects
 *
 * `<details class="spr-dropdown">` rows hold radio inputs with provider icons
 * Closed shows only the checked row; open shows all rows in a popover list
 * Arrow keys on the summary jump into the radio group for native navigation
 * Click or Space on a row confirms the choice and shuts the dropdown
 * Escape also shuts it
 * A click outside closes any open dropdown
 */

export function mountDropdowns(): void {
  const dropdowns = Array.from(
    document.querySelectorAll<HTMLDetailsElement>('details.spr-dropdown'),
  );
  if (dropdowns.length === 0) return;

  const shut = (dropdown: HTMLDetailsElement): void => {
    dropdown.open = false;

    dropdown.querySelector('summary')?.focus();
  };

  const radiosOf = (dropdown: HTMLDetailsElement): HTMLInputElement[] =>
    Array.from(dropdown.querySelectorAll<HTMLInputElement>('.spr-dd-row > input[type="radio"]'));

  for (const dropdown of dropdowns) {
    dropdown.addEventListener('click', (event) => {
      if (!dropdown.open || event.detail === 0) return;
      // Not a real click: the browser fires a programmatic click (detail 0) on radio
      // change; skip it here because the keyup handler closes after the check completes

      if (!(event.target instanceof Element) || !event.target.closest('.spr-dd-row')) return;
      shut(dropdown);
    });

    dropdown.addEventListener('keyup', (event) => {
      if (!dropdown.open || event.key !== ' ') return;
      // keyup not keydown so the radio check completes before closing
      if (!(event.target instanceof Element) || !event.target.closest('.spr-dd-row')) return;
      shut(dropdown);
    });

    dropdown.addEventListener('keydown', (event) => {
      if (!dropdown.open) return;
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      if (event.target instanceof Element && event.target.closest('.spr-dd-row')) return;
      // Focus targets the summary or another non-row element; jump into the radio group
      // Native radio arrow navigation then walks between the rows

      const radios = radiosOf(dropdown);
      if (radios.length === 0) return;
      event.preventDefault();
      (radios.find((radio) => radio.checked) ?? radios[0]).focus();
    });
  }

  addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = dropdowns.find((dropdown) => dropdown.open);

    if (!open) return;
    event.stopPropagation(); // Prevent modal escape handlers from also reacting
    shut(open);
  });

  addEventListener('click', (event) => {
    for (const dropdown of dropdowns) {
      if (!dropdown.open) continue;
      if (event.target instanceof Node && dropdown.contains(event.target)) continue;
      dropdown.open = false;
    }
  });
}
