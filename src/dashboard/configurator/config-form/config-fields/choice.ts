/**
 * A switch between sets of fields, e.g. HTTPS or SSH for a git remote
 *
 * The switch stores nothing itself. It can follow a field drawn below it, such as
 * the remote URL: the option whose prefix that value starts with is the one shown,
 * the browser only accepts a value with the shown option's prefix, and saving
 * removes the values of the fields in every other option. See `settleChoices`
 */

import type { CardItem, Field } from '.';

export interface ChoiceOption {
  value: string;
  label: string;
  items: CardItem[];
  // Start of the followed field's value that selects this option, e.g. `ssh://`
  prefix?: string;
  // Placeholder of the followed field while this option is shown
  placeholder?: string;
  // Shown when the browser refuses a followed value without the prefix
  prefixHint?: string;
}

export interface ChoiceItem {
  kind: 'choice';
  // Names the switch for screen readers, e.g. "Transport"
  label: string;
  // Drawn between the switch and the options' fields; its value picks the option
  follows?: Field;
  // The option shown when the page is drawn
  selected: string;
  options: ChoiceOption[];
}

export function choice(label: string, options: ChoiceOption[], follows?: Field): ChoiceItem {
  const value = follows && 'value' in follows ? follows.value.trim() : '';
  const selected =
    options.find((option) => option.prefix && value.startsWith(option.prefix)) ?? options[0];
  return {
    kind: 'choice',
    label,
    // The followed field starts on the shown option's placeholder
    follows:
      follows && 'placeholder' in follows && selected?.placeholder
        ? { ...follows, placeholder: selected.placeholder }
        : follows,
    selected: selected?.value ?? '',
    options,
  };
}
