import type { Request, Response } from 'express';

import { DashboardResponder } from '../../../../respond';
import { ADMINISTRATOR_SECTION_ID } from '../../../../setup/setup-sections';
import { renderTemplate } from '../../../../../content-reader/views';

/** A configured provider the first-admin login can be completed through */
export interface ProvableProvider {
  id: string;
  /** The display name, for the page's list */
  name: string;
  /** A redirect to an OIDC or GitHub provider, or a magic link sent by email */
  kind: 'redirect' | 'magic-link';
}

/** The data for the become-administrator page */
export interface AdministratorPayload {
  /** The providers the form can start a proving login through */
  provable: ProvableProvider[];
  /** True once an administrator exists, which leaves nothing to prove */
  done: boolean;
  error: string | null;
  /** The address a proving magic link was just sent to, if any */
  sentTo: string | null;
}

/**
 * Sends the become-administrator page
 *
 */
export function sendSetupAdministrator(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: AdministratorPayload,
  formActions: string[],
  status?: number,
): void {
  respond.send(req, res, isAdmin, {
    section: 'setup',
    subsection: ADMINISTRATOR_SECTION_ID,
    title: 'Administrator',
    status,
    formActions,
    payload,
    page: (data) =>
      renderTemplate(
        'dashboard/ui/views/setup/setup-administrator',
        data as unknown as Record<string, unknown>,
      ),
  });
}
