import type { Response } from 'express';

import { renderTemplate, sendHtml } from '../../../../content-reader/views';
import type { ManifestHandoff } from '../../../configurator/config-page/github-app-manifest';

/**
 * sendGithubAppManifest sends the response that posts a GitHub App's manifest to GitHub.
 *
 * @param res the response
 * @param handoff the manifest and where it is posted to
 */
export function sendGithubAppManifest(res: Response, handoff: ManifestHandoff): void {
  sendHtml(
    res,
    (nonce) =>
      renderTemplate('dashboard/ui/views/github-app-manifest', {
        manifestPostUrl: handoff.manifestPostUrl,
        manifest_json: JSON.stringify(handoff.manifest),
        nonce,
      }),
    { formActions: [handoff.web], noStore: true },
  );
}
