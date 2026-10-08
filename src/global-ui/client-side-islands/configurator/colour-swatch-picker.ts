import { configForm, reportScriptedEdit } from './config-form-handle';

/**
 * Connect all colour swatch inputs to their paired text boxes
 */
export function mountSwatches(): void {
  const form = configForm();
  if (!form) return;

  for (const swatch of form.querySelectorAll<HTMLInputElement>('input[data-spr-swatch-for]')) {
    const name = swatch.dataset.sprSwatchFor ?? '';
    const box = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (!box) continue;

    const follow = (): void => {
      const hex = expandHex(box.value.trim()) ?? expandHex(box.placeholder.trim());
      // Not set directly to avoid the colour input throwing on invalid hex
      if (hex) swatch.value = hex;
    };

    follow();
    swatch.hidden = false;

    box.addEventListener('input', follow);
    swatch.addEventListener('input', () => {
      box.value = swatch.value;
      reportScriptedEdit(box);
    });
  }
}

/**
 * Validate input as a hex colour and expand short form to six-digit
 */
function expandHex(value: string): string | null {
  // Matches `#` followed by 3 or 6 hex digits. Group 1: the hex digits without the `#`
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value);
  if (!match) return null;
  const digits = match[1];
  if (digits.length === 6) return `#${digits}`;
  return `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`;
}
