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

export function choice(label: string, options: ChoiceOption[], follows: Field): ChoiceItem {
  const value = 'value' in follows ? follows.value.trim() : '';
  const selected =
    options.find((option) => option.prefix && value.startsWith(option.prefix)) ?? options[0];
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
