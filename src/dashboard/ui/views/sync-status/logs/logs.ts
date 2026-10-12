import type { Request, Response } from 'express';

import { DeadJobRow, RetiredRow } from '../../../../dashboard.repository';
import { DashboardResponder } from '../../../../respond';
import { isoOf, relativeTime } from '../../../../../common/time';
import { renderInlineIcon } from '../../../../../content-reader/icons';
import { renderTemplate } from '../../../../../content-reader/views';

/** Putting a dead job back on the queue, on both Retry buttons */
export const RETRY_ICON = 'rotate-ccw';

/** Retired redirects and dead jobs, to JSON callers and the page alike */
export interface LogsPayload {
  retired_redirects: RetiredRow[];
  dead_jobs: DeadJobRow[];
}

/** Sends the logs page: retired redirects and dead jobs */
export function sendLogs(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: LogsPayload,
  retriedCount: number | null,
): void {
  respond.send(req, res, isAdmin, {
    section: 'logs',
    title: 'Logs',
    payload,
    page: (data) =>
      renderTemplate('dashboard/ui/views/sync-status/logs', {
        retried_note:
          retriedCount === null
            ? null
            : {
                text: `${retriedCount} job(s) put back on the queue. The worker picks them up within a poll; whatever failed has to have been fixed first, or they arrive back here.`,
              },
        retry_icon: renderInlineIcon(RETRY_ICON, 'spr-icon'),
        retired: data.retired_redirects.map((row) => ({
          oldPath: `/${row.namespace}/${row.old_slug}`,
          repo: row.repo_slug,
          claimedBy: row.claimed_by,
          when: relativeTime(row.retired_at),
          whenAt: isoOf(row.retired_at),
        })),
        dead: data.dead_jobs.map((row) => ({
          id: row.id,
          kind: row.kind,

          concerns: row.repo_slug ? `${row.repo_namespace}/${row.repo_slug}` : null,
          concernsHref: row.repo_slug ? `/-/status/${row.repo_namespace}/${row.repo_slug}` : null,
          forge: row.forge_key,
          attempts: row.attempts,
          error: row.last_error,
          when: relativeTime(row.updated_at),
          whenAt: isoOf(row.updated_at),
        })),
      }),
  });
}
