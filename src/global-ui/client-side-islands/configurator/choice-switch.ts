/**
 * Conveniences for the switch of a choice, e.g. HTTPS or SSH for a git remote
 *
 * The switch works without this island: it is a group of radio buttons, and CSS
 * shows the fields of the checked one. This island adds two things:
 * - Typing or pasting a value into the followed field, e.g. the remote URL, that
 *   starts with an option's prefix checks that option
 * - The followed field takes the checked option's placeholder, and its pattern
 *   only accepts values with the checked option's prefix
 */
import { configForm, reportScriptedEdit } from './config-form-handle';

// Escapes the characters that have a meaning in a regular expression
function literal(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

export function mountChoices(): void {
  const form = configForm();
  if (!form) return;

  for (const choice of form.querySelectorAll<HTMLElement>('[data-spr-choice]')) {
    const radios = Array.from(
      choice.querySelectorAll<HTMLInputElement>(':scope > .spr-choice-switch input[type="radio"]'),
    );
    const followed = Array.from(choice.querySelectorAll<HTMLInputElement>('input[name]')).find(
      (input) => input.name === choice.dataset.sprChoice,
    );
    if (!followed) continue;

    // Fits the followed field to the checked option
    const fit = () => {
      const checked = radios.find((radio) => radio.checked);
      if (!checked) return;
      const { sprChoicePrefix: prefix, sprChoicePlaceholder: placeholder } = checked.dataset;
      if (placeholder) followed.placeholder = placeholder;
      if (prefix) {
        followed.pattern = `${literal(prefix)}.*`;
        followed.title = checked.dataset.sprChoiceHint ?? '';
      } else {
        followed.removeAttribute('pattern');
        followed.removeAttribute('title');
      }
    };

    for (const radio of radios) radio.addEventListener('change', fit);

    followed.addEventListener('input', () => {
      const value = followed.value.trim();
      const match = radios.find((radio) => {
        const prefix = radio.dataset.sprChoicePrefix;
        return prefix !== undefined && value.startsWith(prefix);
      });
      if (!match || match.checked) return;
      match.checked = true;
      fit();
      reportScriptedEdit(match);
    });

    fit();
  }
}
