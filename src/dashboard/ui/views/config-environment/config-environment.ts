import type { Request, Response } from 'express';

import { ConfigEnvironmentPayload } from '../../../configurator/config-page/payloads';
import { DashboardResponder } from '../../../respond';
import { readByLabel } from '../../../../common/env';
import { renderTemplate } from '../../../../content-reader/views';

/** Sends the environment page: every variable this process reads */
export function sendConfigEnvironment(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: ConfigEnvironmentPayload,
): void {
  respond.send(req, res, isAdmin, {
    section: 'config',
    title: 'Environment',
    payload,
    page: (data) =>
      renderTemplate('dashboard/ui/views/config-environment', {
        // The registry's word for a variable both entrypoints read is `both`,
        // which is what a JSON caller receives and what code compares against.
        // What a person is shown names the two processes — see `readByLabel`,
        // which the README table renders through as well, so the page and the
        // documentation cannot come to spell it differently.
        rows: data.environment.map((row) => ({ ...row, read_by: readByLabel(row.readBy) })),
      }),
  });
}
