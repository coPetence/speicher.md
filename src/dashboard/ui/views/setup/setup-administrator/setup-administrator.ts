import type { Request, Response } from 'express';

import { DashboardResponder } from '../../../../respond';
import { renderTemplate } from '../../../../../content-reader/views';

/** A configured OIDC provider the first-admin login can be completed through */
export interface ProvableProvider {
  id: string;
  /** The display name, for the page's list */
  name: string;
}

/** The data for the become-administrator page */
export interface AdministratorPayload {
  /** The providers the form can start a proving login through */
  provable: ProvableProvider[];
  /** True once an administrator exists, which leaves nothing to prove */
  done: boolean;
  error: string | null;
}

/** Sends the become-administrator page, whose form posts to /-/setup/prove */
export function sendSetupAdministrator(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: AdministratorPayload,
  status?: number,
): void {
  respond.send(req, res, isAdmin, {
    section: 'setup',
    title: 'Administrator',
    status,
    payload,
    page: (data) =>
      renderTemplate(
        'dashboard/ui/views/setup/setup-administrator',
        data as unknown as Record<string, unknown>,
      ),
  });
}
