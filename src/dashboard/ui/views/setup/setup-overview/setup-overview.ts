import type { Request, Response } from 'express';

import { markSprite } from '../../../provider-marks';
import { DashboardResponder } from '../../../../respond';
import { SetupStep } from '../../../../setup/steps';
import { renderInlineIcon } from '../../../../../content-reader/icons';
import { renderTemplate } from '../../../../../content-reader/views';

/** A step as the overview renders it: SetupStep plus the prose copy from PROSE */
export interface WizardStep extends SetupStep {
  /** Copy and card label; the blurb is help markup */
  blurb: string;
  /** Card heading; action is the label, "Review..." once the step is done */
  heading: string;
  action: string;
}

/** A kind the overview offers as a card, opening the add page on that kind */
export interface ProviderChoice {
  providerKind: string;
  providerLabel: string;
  /** The sprite mark and the page the card opens */
  providerMark: string;
  providerHref: string;
}

/** The data for the setup overview */
export interface WizardPayload {
  steps: WizardStep[];
  /** Cards for what has not been added yet; empty once the step is done */
  sources: ProviderChoice[];
  /** Empty once any provider exists */
  choices: ProviderChoice[];
  /** True once an administrator exists, which ends the flow */
  finished: boolean;
  error: string | null;
}

/** Sends the setup overview: every step with prose, and cards for what can still be added */
export function sendSetup(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: WizardPayload,
): void {
  respond.send(req, res, isAdmin, {
    section: 'setup',
    title: 'Instance setup',
    payload,
    // The page lists the steps itself, so the shared progress bar is not rendered
    listsSetupSteps: true,
    page: (data) =>
      renderTemplate('dashboard/ui/views/setup/setup-overview', {
        ...(data as unknown as Record<string, unknown>),
        // One sprite for every card's mark, so the cards need no per-mark assets
        marks_sprite: markSprite(
          [...data.choices, ...data.sources].map((choice) => choice.providerMark),
        ),
        check_icon: renderInlineIcon('circle-check', 'spr-icon'),
      }),
  });
}
