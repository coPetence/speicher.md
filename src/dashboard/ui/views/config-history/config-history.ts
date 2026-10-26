import type { Request, Response } from 'express';

import { relativeTime } from '../../../../common/time';
import { ConfigVersion } from '../../../../config/loader';
import type { SkippedConfigVersion } from '../../../../config/types';
import { renderInlineIcon } from '../../../../content-reader/icons';
import { escapeHtml, renderTemplate } from '../../../../content-reader/views';
import { diffConfigVersions } from '../../../configurator/config-form/diff';
import type { RepairPreview } from '../../../configurator/repair-preview';
import { DashboardResponder } from '../../../respond';
import { skippedVersionsNote } from '../../config-notes';
import { HISTORY_BLURB } from '../../instance-blurbs';

/** The version history and, when two are picked, the diff between them */
export interface HistoryPayload {
  running_version: number | null;
  from: number | null;
  to: number | null;
  diff: ReturnType<typeof diffConfigVersions> | null;
  restored: number | null;
  error: string | null;
  problems: string[];
  versions: ReturnType<typeof summarise>[];
  skipped: SkippedConfigVersion[];
  repair: RepairPreview | null;
}

/** Sends the configuration history */
export function sendConfigHistory(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: HistoryPayload,
  editable: boolean,
  status?: number,
): void {
  respond.send(req, res, isAdmin, {
    section: 'history',
    title: 'Configuration history',
    payload,
    // The compare selector submits itself on change, and hides its button. An
    // upgrade like every island: the button is in the markup for a browser
    // that does not run it.
    island: 'history',
    page: (data) =>
      renderTemplate('dashboard/ui/views/config-history', {
        ...data,
        // "3 minutes ago" beside each version — presentation, computed at render
        // against the clock the page is drawn on. The payload keeps the stamp.
        versions: data.versions.map((v) => ({ ...v, applied_ago: relativeTime(v.applied_at) })),
        // The mark on Restore, inline like every mark under `/-/`: the page's
        // sprite is what the left column names.
        blurb: HISTORY_BLURB,
        restore_icon: renderInlineIcon('rotate-ccw', 'spr-icon'),
        download_icon: renderInlineIcon('download', 'spr-icon'),
        skipped_note:
          data.skipped.length > 0 && data.running_version !== null
            ? skippedVersionsNote(
                data.skipped,
                data.skipped[0].version,
                data.running_version,
                editable ? data.repair : null,
              )
            : null,
        restored_note: data.restored
          ? {
              level: 'ok',
              text: `Version ${data.restored} restored as a new version.`,
            }
          : null,
        hidden_changes_note: data.diff?.hiddenChanges.length
          ? {
              level: 'warn',
              html: `A stored value changed that is not shown: ${data.diff.hiddenChanges.map((path) => `<code>${escapeHtml(path)}</code>`).join(', ')}.`,
            }
          : null,
        // Presentation only: whether the restore buttons are live. The route is
        // what refuses a write, and it refuses one whatever this says.
        editable,
      }),
    status,
  });
}

/** One row of the history list. The text itself is not part of it. */
export function summarise(
  version: ConfigVersion,
  running: number | null,
  skipped: SkippedConfigVersion[],
) {
  return {
    loads: !skipped.some((skip) => skip.version === version.version),
    version: version.version,
    applied_at: version.applied_at,
    // Null is the seeded version: nobody applied it, it was already what the
    // instance was running.
    applied_by: version.applied_by,
    origin: version.origin,
    resolution_hash: version.resolution_hash,
    running: version.version === running,
  };
}
