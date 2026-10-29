/** The kinds of member each section sets up from its add modal */

import { githubProviderStarter, githubSourceStarter } from './github-app';
import { magicLinkStarter } from './magic-link';
import type { QuickSetup, QuickStarter } from './model';

const QUICK_STARTERS: Record<string, Record<string, QuickStarter>> = {
  identity: { github: githubProviderStarter, 'magic-link': magicLinkStarter },
  sources: { github: githubSourceStarter },
};

/** The quick setup of a kind of member, or undefined when the kind is set up on its page */
export function quickStarterOf(section: string, kind: string): QuickStarter | undefined {
  return Object.hasOwn(QUICK_STARTERS, section) && Object.hasOwn(QUICK_STARTERS[section], kind)
    ? QUICK_STARTERS[section][kind]
    : undefined;
}

/** What the add modal shows for a kind, or undefined when the kind is set up on its page */
export function quickSetupOf(section: string, kind: string): QuickSetup | undefined {
  return quickStarterOf(section, kind)?.setup;
}
