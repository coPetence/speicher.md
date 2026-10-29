import type { Request, Response } from 'express';

import { DashboardResponder } from '../../../../respond';
import { DEFAULT_BRAND_ICON, renderInlineIcon } from '../../../../../content-reader/icons';
import { renderTemplate } from '../../../../../content-reader/views';

export interface WizardPayload {
  // True once the setup is complete
  finished: boolean;
}

/** Sends the setup overview: a welcome, and what the setup does; the guide bar starts it */
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
    page: (data) =>
      renderTemplate('dashboard/ui/views/setup/setup-overview', {
        ...(data as unknown as Record<string, unknown>),
        mark_icon: renderInlineIcon(DEFAULT_BRAND_ICON, 'spr-icon'),
      }),
  });
}
