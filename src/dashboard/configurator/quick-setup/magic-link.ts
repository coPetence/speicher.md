/**
 * Quick setup of a magic link provider: it needs nothing beyond its short id, so
 * the add modal saves it straight away
 */

import type { QuickStarter } from './model';

export const magicLinkStarter: QuickStarter = {
  setup: {
    submitLabel: 'Add the provider',
    fields: [],
  },

  start: () => ({ kind: 'save' }),

  ready: (context) => ({ steps: [{ state: 'done', text: `Provider **${context.id}** saved` }] }),
};
