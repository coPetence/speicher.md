/**
 * Notifications
 *
 * One page over the `notify` block: three notices, one card each. They were
 * three pages once, which put a click between an operator and the answer to
 * "who is told when something stops working" — a question nobody asks about one
 * notice at a time. A card per notice is what keeps the three audiences apart
 * now, and the page reaches no transport field, so a save here cannot write an
 * SMTP password
 */

import { field } from '../field';
import type { Obj } from '../field';
import type { Card, Option } from '../model';
import { sectionHead } from './registry';
import type { SectionSource } from './registry';

const NOTIFY_TARGETS: Option[] = [
  { value: 'admins', label: 'Administrators' },
  { value: 'maintainers', label: 'Repository maintainers' },
  { value: 'committer', label: 'Whoever made the commit' },
];

const STANDING_TARGETS: Option[] = NOTIFY_TARGETS.filter((t) => t.value !== 'committer');

export function notificationsSection(root: Obj): SectionSource {
  return {
    ...sectionHead('notifications'),
    blurb:
      'Who is told, and how long this instance waits before telling them. Every ' +
      'notice goes out over the [mail transport](/-/config/mail) and each target ' +
      'resolves to principals this instance already knows — they are never an ' +
      'address list.',
    fields: [],
    cards: [syncFailureCard(root), staleCard(root), grantExpiryCard(root)],
    addOps: [],
  };
}

function syncFailureCard(root: Obj): Card {
  return {
    title: 'Failed syncs',
    subtitle:
      'Triggered when a repository sync fails. The old pages will be served until the issues get fixed.',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    fields: [
      field(
        root,
        ['notify', 'sync_failure'],
        'notify.sync_failure',
        'Notify about a failed sync',
        'checkboxes',
        {
          options: NOTIFY_TARGETS,
          help:
            'The committer is offered here and nowhere else: a failed sync is the ' +
            'one notice with a person attached to it, and they are usually the only ' +
            'one who can fix the file that caused it. What they are told is generic — ' +
            'the detail that names other repositories goes to administrators and to ' +
            '[the status page](/-/status).',
        },
      ),
    ],
  };
}

function staleCard(root: Obj): Card {
  return {
    title: 'Stale repositories',
    subtitle: 'Triggered when a repository was not synced and got stale.',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    fields: [
      field(
        root,
        ['notify', 'stale'],
        'notify.stale',
        'Tell about a repository that stopped syncing',
        'checkboxes',
        {
          options: STANDING_TARGETS,
          help:
            'No committer: nothing happened, which is the whole point of the notice, ' +
            'so there is nobody whose commit it was.',
        },
      ),
      field(root, ['notify', 'stale_after'], 'notify.stale_after', 'Stale after', 'duration', {
        fallback: '6h',
        startsRow: true,
        help:
          "Measured against the repository's own poll interval, whichever is " +
          'longer — a daily-polled repository is not stale at six hours, it is early, ' +
          'and an alert that always fires is an alert nobody reads.',
      }),
    ],
  };
}

function grantExpiryCard(root: Obj): Card {
  return {
    title: 'Expiring grants',
    subtitle:
      'Triggered before a grant expires, so that grants can be renewed before access gets revoced.',
    removeOp: null,
    notes: [],
    cards: [],
    addOps: [],
    fields: [
      field(
        root,
        ['notify', 'grant_expiry'],
        'notify.grant_expiry',
        'Tell about an expiring grant',
        'checkboxes',
        {
          options: STANDING_TARGETS,
          help:
            'No committer: a grant expires on a date somebody set, not on a commit ' +
            'somebody pushed.',
        },
      ),
      field(
        root,
        ['notify', 'expiry_warning'],
        'notify.expiry_warning',
        'Warn before a grant expires',
        'duration',
        {
          fallback: '14d',
          startsRow: true,
          help: 'How long before the `until` date the notice goes out.',
        },
      ),
    ],
  };
}
