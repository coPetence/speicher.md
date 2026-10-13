/**
 * A switch between sets of fields, e.g. HTTPS or SSH for a git remote
 *
 */

import type { CardItem, Field } from '.';

export interface ChoiceOption {
  value: string;
  label: string;
  items: CardItem[];
  // Start of the followed field's value that belongs to this option, e.g. `ssh://`
  prefix?: string;
  pattern?: string;
  // Placeholder of the followed field while this option is checked
  placeholder?: string;
  // Shown when the browser refuses a followed value without the prefix
  prefixHint?: string;
}

export interface ChoiceItem {
  kind: 'choice';
  // Names the switch for screen readers, e.g. "Transport"
  label: string;
  // Form name the radio buttons submit the checked option under, `choice:<followed path>`
  name: string;
  // Drawn between the switch and the options' fields
  follows: Field;
  selected: string;
  options: ChoiceOption[];
}

/**
 * belongsToChoiceOption returns whether a value of the followed field belongs to an option.
 * @param option the option of the choice
 * @param value the value of the followed field
 */
export function belongsToChoiceOption(option: ChoiceOption, value: string): boolean {
  if (option.prefix && value.startsWith(option.prefix)) return true;
  return option.pattern ? new RegExp(`^(?:${option.pattern})$`, 'u').test(value) : false;
}

export function choice(label: string, options: ChoiceOption[], follows: Field): ChoiceItem {
  const value = 'value' in follows ? follows.value.trim() : '';
  const selected = options.find((option) => belongsToChoiceOption(option, value)) ?? options[0];
  return {
    kind: 'choice',
    label,
    name: `choice:${follows.path}`,
    follows:
      'placeholder' in follows && selected?.placeholder
        ? { ...follows, placeholder: selected.placeholder }
        : follows,
    selected: selected?.value ?? '',
    options,
  };
}
