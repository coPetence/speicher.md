/** The main button of the modal a quick setup ends on */

import { SetupStep, entryHref } from '../../setup/steps';
import type { ReadyModal } from '../config-page/payloads';

/**
 * primaryOf returns the main button of a ready modal: during the first setup, on to the step that is left next;
 * otherwise Done, back to the list.
 *
 * @param steps the steps of the first setup, or none outside it
 * @param section the section the member was added to
 */
export function primaryOf(steps: SetupStep[], section: string): ReadyModal['primary'] {
  const next = steps.find((step) => !step.done);
  if (!next) return { label: 'Done', href: `/-/config/${section}`, onward: false };
  return { label: 'Continue', href: entryHref(next, steps), onward: true };
}
