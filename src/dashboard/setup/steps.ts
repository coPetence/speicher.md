/** Setup wizard steps and navigation for the first-run flow */
import { ConfigService } from '../../config/config.service';

/** Identifiers for the setup wizard steps, in display order */
export type SetupStepId = 'mail' | 'provider' | 'group' | 'administrator' | 'content';

/** A step in the setup wizard, drawn as a list item with status */
export interface SetupStep {
  id: SetupStepId;
  title: string;
  href: string;
  /** Whether the step's prerequisite is satisfied */
  done: boolean;

  /** Whether this step is the one the user is on or should go to next */
  current: boolean;
}

export const MAIL_TRANSPORT_PATH = '/-/config/mail';

/** Subset of ConfigService properties that determine setup completion state */
export type SetupState = Pick<
  ConfigService,
  | 'providerIds'
  | 'hasAdministrator'
  | 'hasContentSource'
  | 'hasMagicLinkProvider'
  | 'hasMailTransport'
>;

/** The overview's copy for a step: heading, blurb, and the card's link label */
export interface StepProse {
  heading: string;
  blurb: string;
  /** The label while the step is undone, and the one once it is done */
  action: string;
  reviewAction: string;
}

export const STEP_PROSE: Record<SetupStepId, StepProse> = {
  mail: {
    heading: 'Mail transport',
    blurb:
      'Configure SMTP so the instance can send email. Magic-link providers need a relay ' +
      'to deliver their sign-in links.',
    action: 'Configure mail',
    reviewAction: 'Review mail',
  },
  provider: {
    heading: 'Identity provider',
    blurb:
      'Please first add an identity provider you can log in through, and that supports OpenID Connect. ' +
      'This is required to sign in as the first administrator of this instance. Further providers can be added alongside it, for example to let external collaborators sign in with their own accounts.',
    action: 'Add an Identity provider',
    reviewAction: 'Review Identity providers',
  },
  group: {
    heading: 'Groups',
    blurb:
      'Manage the groups of users in your instance. You can create, edit, and delete groups, as well as add or remove users from them.',
    action: 'Manage groups',
    reviewAction: 'Review groups',
  },
  content: {
    heading: 'Content source',
    blurb:
      'Connect the Git repositories that hold your documentation. Speicher reads the Markdown files and images from them and keeps them in sync as changes are pushed. GitHub, GitLab, Gitea, Forgejo and any plain Git remote are supported.',
    action: 'Add a source',
    reviewAction: 'Review sources',
  },
  administrator: {
    heading: 'Become the first administrator',
    blurb:
      'To become the first administrator of this instance, you need to sign in through an identity provider that supports OpenID Connect. ' +
      'This permanently closes the instance to further claims.',
    action: 'Sign in',
    reviewAction: 'Sign in',
  },
};

export function setupSteps(config: SetupState, currentPath?: string): SetupStep[] {
  const steps: SetupStep[] = [
    // Not shown unless a magic-link provider exists, mail is configured, or the
    // user is on the mail page because only magic-link providers need a relay
    ...(config.hasMagicLinkProvider ||
    config.hasMailTransport ||
    currentPath === MAIL_TRANSPORT_PATH
      ? [
          {
            id: 'mail' as const,
            title: 'Mail transport',
            href: MAIL_TRANSPORT_PATH,
            done: config.hasMailTransport,
            current: false,
          },
        ]
      : []),
    {
      id: 'provider',
      title: 'Identity provider',
      href: '/-/config/identity',
      done: config.providerIds.length > 0,
      current: false,
    },
    {
      id: 'group',
      title: 'Groups',
      href: '/-/config/groups',
      done: config.providerIds.length > 0,
      current: false,
    },
    {
      id: 'content',
      title: 'Content source',
      href: '/-/config/sources',
      done: config.hasContentSource,
      current: false,
    },
    {
      id: 'administrator',
      title: 'Administrator',
      href: '/-/setup/administrator',
      done: config.hasAdministrator,
      current: false,
    },
  ];
  const current =
    currentPath === undefined
      ? steps.find((step) => !step.done)
      : steps.find((step) => currentPath === step.href || currentPath.startsWith(`${step.href}/`));
  if (current) current.current = true;
  return steps;
}

/** Snapshot the setup-relevant state of a ConfigService for later comparison */
export function setupStateOf(config: SetupState): SetupState {
  return {
    providerIds: config.providerIds,
    hasAdministrator: config.hasAdministrator,
    hasContentSource: config.hasContentSource,
    hasMagicLinkProvider: config.hasMagicLinkProvider,
    hasMailTransport: config.hasMailTransport,
  };
}

/** Find the step whose href matches /-/config/{sectionId} */
function stepAt(steps: SetupStep[], sectionId: string): SetupStep | undefined {
  return (
    steps.find((step) => step.href === `/-/config/${sectionId}`) ??
    steps.find((step) => step.href === `/-/config/${sectionId.split('/')[0]}`)
  );
}

/** Return the next page to redirect to after a setup section is saved, or null */
export function nextSetupPage(
  before: SetupState,
  after: SetupState,
  sectionId: string,
): string | null {
  const finished = stepAt(setupSteps(after), sectionId);
  if (!finished?.done) return null;
  // Already done before this save: nothing changed
  if (stepAt(setupSteps(before), sectionId)?.done === true) return null;

  const next = setupSteps(after).find((step) => !step.done);
  if (!next) return null;

  // When mail is done and provider is next, hint magic-link as the kind to add
  if (finished.id === 'mail' && next.id === 'provider') return `${next.href}?kind=magic-link`;
  return next.href;
}
