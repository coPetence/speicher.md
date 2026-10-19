import type { Request, Response } from 'express';

import { RetiredRow } from '../../../../dashboard.repository';
import { DashboardResponder } from '../../../../respond';
import { isoOf, relativeTime } from '../../../../../common/time';
import { renderTemplate } from '../../../../../content-reader/views';

/** Retired redirects, to JSON callers and the page alike */
export interface RedirectsPayload {
  retired_redirects: RetiredRow[];
}

/** Sends the retired redirects page: old paths that no longer lead to a renamed repo */
export function sendRedirects(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: RedirectsPayload,
): void {
  respond.send(req, res, isAdmin, {
    section: 'redirects',
    title: 'Retired redirects',
    payload,
    page: (data) =>
      renderTemplate('dashboard/ui/views/sync-status/redirects', {
        retired: data.retired_redirects.map((row) => ({
          oldPath: `/${row.namespace}/${row.old_slug}`,
          repo: row.repo_slug,
          claimedBy: row.claimed_by,
          when: relativeTime(row.retired_at),
          whenAt: isoOf(row.retired_at),
        })),
      }),
  });
}
