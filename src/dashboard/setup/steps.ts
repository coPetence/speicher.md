/** Setup wizard steps and navigation for the first-run flow */
import { ConfigService } from '../../config/config.service';

/** Identifiers for the setup wizard steps, in display order */
export type SetupStepId =
  | 'mail'
  | 'provider'
  | 'administrator'
  | 'group'
  | 'content'
  | 'repository';

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
export const REPOSITORY_STEP_PATH = '/-/repositories';

export const SETUP_LATER_COOKIE = 'speicher_setup_later';
export const SETUP_LATER_PATH = '/-/setup/later';

/** Subset of ConfigService properties that determine setup completion state */
export type SetupState = Pick<
  ConfigService,
  | 'providerShortIds'
  | 'hasAdministrator'
  | 'hasContentSource'
  | 'hasMagicLinkProvider'
  | 'hasMailTransport'
  | 'groupNames'
  | 'groupItems'
>;

export const SETUP_COMPLETE_PATH = '/-/setup/complete';

export function setupSteps(
  config: SetupState,
  currentPath?: string,
  readsPage = false,
): SetupStep[] {
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
      done: config.providerShortIds.length > 0,
      current: false,
    },
    {
      id: 'administrator',
      title: 'Administrator',
      href: '/-/setup/administrator',
      done: config.hasAdministrator,
      current: false,
    },
    {
      id: 'group',
      title: 'Groups',
      href: '/-/config/groups',
      // A group without members grants nobody anything
      done: config.groupNames.some((name) => config.groupItems(name).length > 0),
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
      id: 'repository',
      title: 'Repositories',
      href: REPOSITORY_STEP_PATH,
      done: readsPage,
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

/**
 * entryHref returns where a step is entered from the step before it: its page, or the add modal its setup starts in.
 *
 * @param step the step entered
 * @param steps the steps of the setup
 */
export function entryHref(step: SetupStep, steps: SetupStep[]): string {
  // A relay is only set up for a magic-link provider, which is added next
  if (step.id === 'provider' && steps.some((each) => each.id === 'mail' && each.done)) {
    return `${step.href}?kind=magic-link`;
  }
  return step.href;
}

export interface SetupGuide {
  step: SetupStep | null;
  position: number;
  count: number;
  // `complete` posts to the address, which ends the setup
  onward: { label: string; href: string; complete: boolean } | null;
}

// On a step's page the bar leads to the next one; elsewhere it starts the setup, or takes it up again
function onwardLabel(step: SetupStep | null, steps: SetupStep[]): string {
  if (step) return 'Next';
  return steps.some((each) => each.done) ? 'Continue setup' : 'Start';
}

export function setupGuide(steps: SetupStep[]): SetupGuide {
  const step = steps.find((each) => each.current) ?? null;
  const next = steps.find((each) => !each.done && each !== step);
  const finished = steps.some((each) => each.id === 'repository' && each.done);
  const onward = finished
    ? { label: 'Complete setup', href: SETUP_COMPLETE_PATH, complete: true }
    : next && (step === null || step.done)
      ? { label: onwardLabel(step, steps), href: entryHref(next, steps), complete: false }
      : null;
  return {
    step,
    position: step ? steps.indexOf(step) + 1 : 0,
    count: steps.length,
    onward,
  };
}
