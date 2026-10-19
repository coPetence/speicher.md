import type { Request, Response } from 'express';

import { forgeMark } from '../../../../configurator/config-form/members';
import { renderInlineMark } from '../../../provider-marks';
import { DashboardResponder } from '../../../../respond';
import { RepoRunsPayload } from '../../../../status/status.types';
import { approximateDuration } from '../../../../../common/time';
import { renderInlineIcon } from '../../../../../content-reader/icons';
import { renderTemplate } from '../../../../../content-reader/views';
import { runView } from '../run-status/run-status';

/** Fetching the repository again, on the button and nowhere else */
export const SYNC_ICON = 'refresh-cw';

/** The same button while a sync is in flight; turned by `.spr-spin` */
export const SYNCING_ICON = 'loader-circle';

/** Sends one repository's status: recent runs, config summary and findings */
export function sendRepo(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: RepoRunsPayload,
): void {
  respond.send(req, res, isAdmin, {
    section: 'status',
    title: `${payload.namespace}/${payload.slug}`,
    /*
      Watches a sync in flight and reloads when it lands, so the run appears in
      the table and the button comes back. See `client-side-islands/repo-status.ts`.
    */
    island: 'repo-status',
    payload,
    page: (answer) =>
      renderTemplate('dashboard/ui/views/sync-status/repo-status', {
        name: `${answer.namespace}/${answer.slug}`,
        namespace: answer.namespace,
        slug: answer.slug,
        /*
          The source's mark before the name, as the overview's row draws it. Inline
          rather than a reference into a sprite: one mark on the page, so a sprite
          would be the same shapes plus a `<use>`.
        */
        mark_html: renderInlineMark(forgeMark(answer.forge_type), 'spr-icon'),
        sync_icon: renderInlineIcon(SYNC_ICON, 'spr-icon'),
        syncing_icon: renderInlineIcon(SYNCING_ICON, 'spr-icon spr-spin'),

        syncing: answer.syncing,

        config: answer.config && {
          title: answer.config.display_title,
          hasCover: answer.config.has_cover,
          hasConfig: answer.config.has_config,
          maintainers: answer.config.maintainer_principals,
          granted: answer.config.root_granted,
          principals: answer.config.root_principals,

          excludedFromRetrieval: answer.config.indexable === false,
          polls: answer.config.poll_interval_ms
            ? approximateDuration(answer.config.poll_interval_ms)
            : '',
        },
        // Findings are drawn on the run's own page; the table says how many
        show_findings: isAdmin,
        runs: answer.runs.map((run) => runView(answer.namespace, answer.slug, run)),
      }),
  });
}
