/**
 * The manifest flow that creates a GitHub App, for a content source or an identity provider

 */

import { Document } from 'yaml';

import { FLOW_TTL_MS } from '../../../auth/github.service';
import { mintToken } from '../../../auth/tokens';
import { Logger, rootLogger } from '../../../common/logger';
import { isPublicUrl } from '../../../common/public-url';
import { LoginFlow, initModels } from '../../../db/models';
import { githubHosts } from '../../../forge/github/hosts';
import {
  AppManifest,
  ConvertedApp,
  appManifest,
  convertManifestCode,
  manifestFormUrl,
} from '../../../forge/github/manifest';
import { webhookPath, webhookUrl } from '../../../forge/webhook-url';
import { writeAt } from '../config-form/document';
import { memberSectionId } from '../config-form/members';

const FLOW_MARK = 'github-app:';

// Holds the base URL of a GitHub Enterprise Server while the browser is on GitHub; empty for GitHub.com
export const GITHUB_APP_BASE_URL_COOKIE = 'speicher_github_app_base_url';

/**
 * githubAppCallbackPath returns the path GitHub sends the browser back to after it created an App.
 *
 * @param sectionId the config page the App is created for, e.g. `sources/gh`
 */
export function githubAppCallbackPath(sectionId: string): string {
  return `/-/config/${sectionId}/github-app/manifest/callback`;
}

export class GithubAppManifestError extends Error {}

export interface ManifestUrls {
  origin: string;
  redirectUrl: string;
  setupUrl: string;
}

// What an App is created for, e.g. a content source or an identity provider
export interface ManifestTarget {
  // The config page the App is created for, e.g. `sources/gh`
  sectionId: string;
  // Where the target lives in the configuration document, e.g. `['forges', 'gh']`
  path: string[];
  // The kind a new target is created as, e.g. `github`
  kind: string;
  // The base URL of a GitHub Enterprise Server; undefined for GitHub.com
  baseUrl?: string;
  manifest: (urls: ManifestUrls) => AppManifest;
  values: (app: ConvertedApp) => [string[], string | undefined][];
}

export interface ManifestHandoff {
  // The page on GitHub the manifest is posted to
  manifestPostUrl: string;
  manifest: AppManifest;
  web: string;
  owner: string;
  // The config page the flow started on
  configPageUrl: string;
}

/**
 * contentSourceTarget returns the target of the App of a new GitHub content source.
 *
 * @param forgeId the id of the content source
 * @param baseUrl the base URL of a GitHub Enterprise Server. If it is empty, the App is created on GitHub.com
 */
export function contentSourceTarget(forgeId: string, baseUrl = ''): ManifestTarget {
  return {
    sectionId: memberSectionId('sources', forgeId),
    path: ['forges', forgeId],
    kind: 'github',
    baseUrl: baseUrl || undefined,
    manifest: ({ origin, redirectUrl, setupUrl }) => {
      const hook = webhookUrl(forgeId) ?? `${origin}${webhookPath(forgeId)}`;
      return appManifest({
        purpose: 'content-source',
        homepage: origin,
        // GitHub refuses a webhook it cannot reach, e.g. on `localhost`
        webhookUrl: isPublicUrl(hook) ? hook : undefined,
        redirectUrl,
        setupUrl,
      });
    },
    values: (app) => [
      [['base_url'], baseUrl || undefined],
      [['app_id'], String(app.id)],
      [['private_key'], app.pem],
      // An App created without a webhook has no secret, and the source needs one
      [['webhook_secret'], app.webhook_secret ?? mintToken(32)],
    ],
  };
}

/**
 * fillWithApp writes the App's values into the target in a configuration document.
 *
 * @param doc the configuration document the page is built from
 * @param target what the App was created for
 * @param app the App GitHub created
 */
export function fillWithApp(doc: Document, target: ManifestTarget, app: ConvertedApp): void {
  for (const [path, value] of target.values(app)) {
    writeAt(doc, [...target.path, ...path], value);
  }
}

export class GithubAppManifestService {
  private readonly log: Logger = rootLogger.child('config.github-app');

  constructor(
    private readonly fetchImpl: typeof fetch = fetch, // Overridable for tests
  ) {
    initModels();
  }

  /**
   * start stores the state of a new flow and builds the manifest of the target's App.
   *
   * @param tenantId the tenant the target belongs to
   * @param target what the App is created for
   * @param owner the organization the App is created on. If it is empty, the App is created on the person's own account
   * @param origin the address of this instance, which GitHub sends the browser back to
   */
  async start(
    tenantId: string,
    target: ManifestTarget,
    owner: string,
    origin: string,
  ): Promise<ManifestHandoff> {
    const configPageUrl = `/-/config/${target.sectionId}`;
    const state = mintToken(24);
    await LoginFlow.create({
      tenant_id: tenantId,
      provider: `${FLOW_MARK}${target.sectionId}`,
      state,
      // A manifest flow has no nonce and no verifier; the columns are filled as a sign-in fills them
      nonce: mintToken(24),
      code_verifier: mintToken(24),
      redirect_to: configPageUrl,
      names_first_admin: false,
      expires_at: new Date(Date.now() + FLOW_TTL_MS),
    });

    const { web } = githubHosts(target.baseUrl);
    const manifest = target.manifest({
      origin,
      redirectUrl: `${origin}${githubAppCallbackPath(target.sectionId)}`,
      setupUrl: `${origin}${configPageUrl}`,
    });
    return {
      manifestPostUrl: manifestFormUrl(web, owner, state),
      manifest,
      web,
      owner,
      configPageUrl,
    };
  }

  /**
   * complete checks the state GitHub sent back, and exchanges the code for the App GitHub created.
   *
   * @param tenantId the tenant the target belongs to
   * @param target what the App is created for
   * @param code the code from GitHub's redirect
   * @param state the state from GitHub's redirect
   */
  async complete(
    tenantId: string,
    target: ManifestTarget,
    code: string,
    state: string,
  ): Promise<ConvertedApp> {
    const flow = await LoginFlow.findOne({
      where: { tenant_id: tenantId, state, provider: `${FLOW_MARK}${target.sectionId}` },
    });
    if (!flow) {
      throw new GithubAppManifestError(
        'Speicher does not know this answer from GitHub, or has already used it. To create the App, start again on this page.',
      );
    }
    await LoginFlow.destroy({ where: { id: flow.id } });
    if (flow.expires_at.getTime() < Date.now()) {
      throw new GithubAppManifestError(
        'The request to create the App has expired. To create the App, start again on this page.',
      );
    }

    try {
      return await convertManifestCode(githubHosts(target.baseUrl).api, code, this.fetchImpl);
    } catch (err) {
      this.log.warn('could not convert the manifest code', {
        target: target.sectionId,
        error: (err as Error).message,
      });
      throw new GithubAppManifestError(
        'GitHub did not hand over the App. To create the App, start again on this page.',
      );
    }
  }
}
