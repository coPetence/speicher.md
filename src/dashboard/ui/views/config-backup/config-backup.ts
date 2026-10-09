import type { Request, Response } from 'express';

import { ConfigBackupPayload } from '../../../configurator/config-page/payloads';
import { DashboardResponder } from '../../../respond';
import { renderInlineIcon } from '../../../../content-reader/icons';
import { renderTemplate } from '../../../../content-reader/views';

/**
 * The backup page's blurb, here rather than in the template because it names the
 * documentation: a link that leaves the instance carries a mark, and the mark
 * comes from the template's `md()` — every explanatory sentence on `/-/` goes through it.
 */
const BACKUP_BLURB =
  'You can download the current state of your configuration as a YAML file and ' +
  'use it to bootstrap a new instance. Find out more in our ' +
  '[documentation](https://docs.speicher.md/operate/configuration)';

/** Sends the page that offers the configuration download, and says what is in it */
export function sendConfigBackup(
  respond: DashboardResponder,
  req: Request,
  res: Response,
  isAdmin: boolean,
  payload: ConfigBackupPayload,
): void {
  respond.send(req, res, isAdmin, {
    section: 'config',
    title: 'Backup',
    payload,
    page: (data) =>
      renderTemplate('dashboard/ui/views/config-backup', {
        ...(data as unknown as Record<string, unknown>),
        blurb: BACKUP_BLURB,
        // Inline, for the reason every mark under `/-/` is: the page's sprite is
        // what the left column names, and this page is not in it.
        download_icon: renderInlineIcon('download', 'spr-link-mark'),
      }),
  });
}
