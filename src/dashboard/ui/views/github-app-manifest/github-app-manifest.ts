import type { Response } from 'express';

import { FLOW_TTL_MS } from '../../../../auth/github.service';
import { env } from '../../../../common/env';
import { renderTemplate, sendHtml } from '../../../../content-reader/views';
import { redirectTo } from '../../../configurator/config-http';
import {
  GITHUB_APP_FORM_COOKIE,
  GITHUB_APP_HANDOFF_COOKIE,
  ManifestHandoff,
  ManifestTarget,
  githubAppCallbackPath,
  githubAppHandoffPath,
} from '../../../configurator/config-page/github-app-manifest';

// Where Back from GitHub leads: the add modal, or the page the App is created for
export type HandoffOrigin = 'modal' | 'page';

/**
 * handOffToGithub keeps the sealed form for the way back and the sealed manifest for the page that posts it, then
 * redirects there. The page is reached by a redirect, not as the answer to a form, so Back from GitHub reloads it
 * rather than asking to send the form again; and as its cookie is gone by then, it leads back instead of to GitHub.
 *
 * @param res the response
 * @param target what the App is created for
 * @param started the sealed form and hand-off, as the flow's start returned them
 * @param from where the flow started, which Back from GitHub returns to
 */
export function handOffToGithub(
  res: Response,
  target: ManifestTarget,
  started: { sealedForm: string; sealedHandoff: string },
  from: HandoffOrigin,
): void {
  const cookie = {
    httpOnly: true,
    secure: !env('SPEICHER_INSECURE_COOKIES'),
    sameSite: 'lax',
  } as const;
  res.cookie(GITHUB_APP_FORM_COOKIE, started.sealedForm, {
    ...cookie,
    path: githubAppCallbackPath(target.sectionId, target.app),
    maxAge: FLOW_TTL_MS,
  });
  const handoffPath = githubAppHandoffPath(target.sectionId, target.app);
  res.cookie(GITHUB_APP_HANDOFF_COOKIE, started.sealedHandoff, {
    ...cookie,
    path: handoffPath,
    maxAge: FLOW_TTL_MS,
  });
  redirectTo(res, from === 'modal' ? `${handoffPath}?from=modal` : handoffPath);
}

/**
 * sendGithubAppManifest sends the page that posts a GitHub App's manifest to GitHub.
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
