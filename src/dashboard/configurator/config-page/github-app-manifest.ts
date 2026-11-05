/**
 * The manifest flow that creates a GitHub App, for a content source, an identity provider or a directory lookup

 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { Document } from 'yaml';

import { GITHUB_CALLBACK_PATH } from '../../../auth/callback-url';
import { FLOW_TTL_MS } from '../../../auth/github.service';
import { mintToken } from '../../../auth/tokens';
import { Logger, rootLogger } from '../../../common/logger';
import { isLocalhostUrl } from '../../../common/public-url';
import { LoginFlow, initModels } from '../../../db/models';
import {
  AppManifest,
  ConvertedApp,
  appManifest,
  convertManifestCode,
  manifestFormUrl,
} from '../../../github/app-manifest';
import { githubHosts } from '../../../github/hosts';
import {
  directoryWebhookPath,
  directoryWebhookUrl,
  webhookPath,
  webhookUrl,
} from '../../../webhooks/webhook-url';
import { choiceName } from '../config-form/config-fields';
import { setNodeAt } from '../config-form/document';
import { memberSectionId } from '../config-form/members';
import type { Uploads } from '../config-form/upload';

const FLOW_MARK = 'github-app:';

// Holds the page's form, sealed, while the browser is on GitHub
export const GITHUB_APP_FORM_COOKIE = 'speicher_github_app_form';

// Holds the manifest, sealed, for the one visit of the page that posts it to GitHub
export const GITHUB_APP_HANDOFF_COOKIE = 'speicher_github_app_handoff';

// Browsers keep a cookie of up to 4096 bytes, its name and attributes included
const MAX_SEALED_FORM = 3800;

/**
 * githubAppPath returns the path the flow of one App on a config page starts at.
 *
 * @param sectionId the config page the App is created for, e.g. `sources/gh`
 * @param app which App of the page, e.g. `github-app`
 */
export function githubAppPath(sectionId: string, app: string): string {
  return `/-/config/${sectionId}/${app}/manifest`;
}

/**
 * readyPath returns the path of the page that lists what was set up for a member, and what to do next.
 *
 * @param sectionId the member's config page, e.g. `identity/github`
 */
export function readyPath(sectionId: string): string {
  return `/-/config/${sectionId}/ready`;
}

/**
 * providerInstallPath returns the path that starts the installation of a provider's App, so that its return can sign
 * the person installing it in.
 *
 * @param providerId the provider's short id
 */
export function providerInstallPath(providerId: string): string {
  return `/-/config/identity/${encodeURIComponent(providerId)}/install`;
}

/**
 * sourceCheckPath returns the path of the modal that checks the repositories a source reads.
 *
 * @param forgeId the source's short id
 */
export function sourceCheckPath(forgeId: string): string {
  return `/-/config/sources/${encodeURIComponent(forgeId)}/check`;
}

/**
 * sourceGroupsPath returns the path of the modal that creates the groups a source's repositories name.
 *
 * @param forgeId the source's short id
 */
export function sourceGroupsPath(forgeId: string): string {
  return `/-/config/sources/${encodeURIComponent(forgeId)}/groups`;
}

export type ConfigFileBack = 'check' | 'setup';

export function repositoriesConfigFilePath(
  forgeId: string,
  repository: string,
  branch: string,
): string {
  const query = new URLSearchParams({ config_file: forgeId, repository, branch });
  return `/-/repositories?${query}`;
}

export function sourceConfigFilePath(
  forgeId: string,
  repository: string,
  branch: string,
  back: ConfigFileBack = 'check',
): string {
  const query = new URLSearchParams({ repository, branch, ...(back === 'setup' ? { back } : {}) });
  return `/-/config/sources/${encodeURIComponent(forgeId)}/config-file?${query}`;
}

/**
 * githubAppHandoffPath returns the path of the page that posts an App's manifest to GitHub. It is reached by a redirect,
 * so the page the browser comes back to from GitHub is not the answer to a form.
 *
 * @param sectionId the config page the App is created for, e.g. `sources/gh`
 * @param app which App of the page, e.g. `github-app`
 */
export function githubAppHandoffPath(sectionId: string, app: string): string {
  return `${githubAppPath(sectionId, app)}/handoff`;
}

/**
 * githubAppCallbackPath returns the path GitHub sends the browser back to after it created an App.
 *
 * @param sectionId the config page the App is created for, e.g. `sources/gh`
 * @param app which App of the page, e.g. `github-app`
 */
export function githubAppCallbackPath(sectionId: string, app: string): string {
  return `${githubAppPath(sectionId, app)}/callback`;
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
  app: string;
  // Where the member lives in the configuration document, e.g. `['forges', 'gh']`
  path: string[];
  // `new` when the App comes with a member that is not stored yet; `either` when it fills a stored member or a new one
  member: 'new' | 'either';
  // The kind a new member is created as, e.g. `github`
  kind: string;
  // The base URL of a GitHub Enterprise Server; undefined for GitHub.com
  baseUrl?: string;
  // The form name of the page's switch between creating the App and entering it manually
  switchName: string;
  // Whether the browser lands on the member's ready page once the App is saved, rather than on GitHub to install it
  landsOnReady: boolean;
  manifest: (urls: ManifestUrls) => AppManifest;
  values: (app: ConvertedApp) => [string[], string][];
  stored?: (app: ConvertedApp) => [string[], unknown][];
  // What a quick setup fills in that the add modal does not ask, where the member has nothing yet
  quickDefaults?: (app: ConvertedApp) => [string[], unknown][];
  unsavedNotice: (installUrl: string) => string;
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

export interface CarriedForm {
  body: Record<string, string | string[]>;
  parts: Record<string, string>;
  // Started from the add modal, which carries no page: the App's values are written into the member, not decoded from a form
  quick?: boolean;
  // Whether the add modal asked for a public App, stored with it so the provider can say who signs in
  public?: boolean;
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
    app: 'github-app',
    path: ['forges', forgeId],
    member: 'new',
    kind: 'github',
    baseUrl: baseUrl || undefined,
    switchName: choiceName(`forges.${forgeId}.app`),
    landsOnReady: true,
    manifest: ({ origin, redirectUrl, setupUrl }) => {
      const hook = webhookUrl(forgeId) ?? `${origin}${webhookPath(forgeId)}`;
      return appManifest({
        purpose: 'content-source',
        homepage: origin,
        // GitHub refuses a webhook on `localhost`
        webhookUrl: isLocalhostUrl(hook) ? undefined : hook,
        redirectUrl,
        setupUrl,
      });
    },
    // An App on one account reads that account's repositories only, so its name says nothing in their URLs
    quickDefaults: (app) =>
      app.owner ? [[['default_repository_owner'], app.owner.accountName]] : [],
    values: (app) => [
      [['app_id'], String(app.id)],
      [['private_key'], app.pem],
      // An App created without a webhook has no secret, and the source then accepts no deliveries
      ...(app.webhook_secret
        ? [[['webhook_secret'], app.webhook_secret] as [string[], string]]
        : []),
    ],
    unsavedNotice: (installUrl) =>
      `App successfully created, but this page could not be saved yet. The App's credentials are filled in below. Fix the problems on this page and save it, then [install the App](${installUrl}) on the repositories speicher.md should be able to read.`,
  };
}

/**
 * identityProviderTarget returns the target of the App of a new GitHub identity provider.
 *
 * @param providerId the id of the identity provider
 * @param baseUrl the base URL of a GitHub Enterprise Server. If it is empty, the App is created on GitHub.com
 * @param isPublic whether anyone with a GitHub account may sign in, rather than only the members of the App's owner
 * @param signInOnInstall whether the person installing the App signs in with it as they do, which then returns
 *   through the sign-in callback rather than the setup URL
 */
export function identityProviderTarget(
  providerId: string,
  baseUrl = '',
  isPublic = false,
  signInOnInstall = false,
): ManifestTarget {
  return {
    sectionId: memberSectionId('identity', providerId),
    app: 'github-app',
    path: ['auth', 'providers', providerId],
    member: 'new',
    kind: 'github',
    baseUrl: baseUrl || undefined,
    switchName: choiceName(`auth.providers.${providerId}.app`),
    landsOnReady: true,
    manifest: ({ origin, redirectUrl, setupUrl }) =>
      appManifest({
        purpose: 'identity-provider',
        homepage: origin,
        callbackUrl: `${origin}${GITHUB_CALLBACK_PATH}`,
        redirectUrl,
        setupUrl,
        public: isPublic,
        signInOnInstall,
      }),
    values: (app) => [
      [['client_id'], app.client_id],
      [['client_secret'], app.client_secret],
    ],
    stored: (app) =>
      app.slug && app.owner
        ? [
            [
              ['app'],
              {
                client_id: app.client_id,
                slug: app.slug,
                owner_account: app.owner.accountName,
                owner_is_organization: app.owner.isOrganization,
              },
            ],
          ]
        : [],
    unsavedNotice: (installUrl) =>
      `App successfully created, but this page could not be saved yet. The App's credentials are filled in below. Fix the problems on this page and save it, then [install the App](${installUrl}) on the organization whose members should be able to sign in, so speicher.md can read their teams.`,
  };
}

/**
 * directoryTarget returns the target of the directory lookup App of a GitHub identity provider, stored or new.
 *
 * @param providerId the id of the identity provider
 * @param baseUrl the base URL of a GitHub Enterprise Server. If it is empty, the App is created on GitHub.com
 */
export function directoryTarget(providerId: string, baseUrl = ''): ManifestTarget {
  return {
    sectionId: memberSectionId('identity', providerId),
    app: 'github-directory-app',
    path: ['auth', 'providers', providerId],
    member: 'either',
    kind: 'github',
    baseUrl: baseUrl || undefined,
    switchName: choiceName(`auth.providers.${providerId}.directory.app`),
    landsOnReady: false,
    manifest: ({ origin, redirectUrl, setupUrl }) => {
      const hook =
        directoryWebhookUrl(providerId) ?? `${origin}${directoryWebhookPath(providerId)}`;
      return appManifest({
        purpose: 'directory',
        homepage: origin,
        // GitHub refuses a webhook on `localhost`
        webhookUrl: isLocalhostUrl(hook) ? undefined : hook,
        redirectUrl,
        setupUrl,
      });
    },
    values: (app) => [
      [['directory', 'app_id'], String(app.id)],
      [['directory', 'private_key'], app.pem],
      ...(app.webhook_secret
        ? [[['directory', 'webhook_secret'], app.webhook_secret] as [string[], string]]
        : []),
    ],
    unsavedNotice: (installUrl) =>
      `App successfully created, but this page could not be saved yet. The App's id and private key are filled in below. Fix the problems on this page and save it, then [install the App](${installUrl}) on every organization whose members and teams speicher.md should look up.`,
  };
}

// The Apps that can be created from each config page, by the path segment of their flow
export const MANIFEST_TARGETS: Record<
  string,
  Record<string, (id: string, baseUrl?: string) => ManifestTarget>
> = {
  sources: { 'github-app': contentSourceTarget },
  identity: { 'github-app': identityProviderTarget, 'github-directory-app': directoryTarget },
};

/**
 * carryForm returns the parts of a submitted page that are carried to GitHub and back.
 *
 * @param body the submitted form
 * @param uploads the files picked on the page
 */
export function carryForm(body: Record<string, unknown>, uploads: Uploads): CarriedForm {
  const carried: CarriedForm = { body: {}, parts: {} };
  for (const [name, value] of Object.entries(body)) {
    if (typeof value === 'string') carried.body[name] = value;
    else if (Array.isArray(value)) {
      carried.body[name] = value.filter((one): one is string => typeof one === 'string');
    }
  }
  for (const [name, bytes] of uploads.parts) carried.parts[name] = bytes.toString('base64');
  return carried;
}

/**
 * uploadsOf returns the files picked on the page, as the page submitted them.
 *
 * @param form the carried form
 */
export function uploadsOf(form: CarriedForm): Uploads {
  const parts = new Map<string, Buffer>();
  for (const [name, base64] of Object.entries(form.parts)) {
    parts.set(name, Buffer.from(base64, 'base64'));
  }
  return { parts, refusal: null };
}

/**
 * appFields returns the App's credentials as the page's form submits them.
 *
 * @param target what the App was created for
 * @param app the App GitHub created
 */
export function appFields(target: ManifestTarget, app: ConvertedApp): Record<string, string> {
  return Object.fromEntries(
    target.values(app).map(([path, value]) => [[...target.path, ...path].join('.'), value]),
  );
}

/**
 * writeAppValues writes all of the App's values into the member, as a quick setup with no page saves them.
 *
 * @param doc the configuration document
 * @param target what the App was created for
 * @param app the App GitHub created
 * @param form the carried form, which says how the add modal set the App up
 */
export function writeAppValues(
  doc: Document,
  target: ManifestTarget,
  app: ConvertedApp,
  form: CarriedForm,
): boolean {
  for (const [path, value] of target.values(app)) setNodeAt(doc, [...target.path, ...path], value);
  for (const [path, value] of target.quickDefaults?.(app) ?? []) {
    if (doc.getIn([...target.path, ...path]) === undefined) {
      setNodeAt(doc, [...target.path, ...path], value);
    }
  }
  // Only an App the provider stores has the visibility the modal asked for written beside it
  if (writeStoredValues(doc, target, app) && typeof form.public === 'boolean') {
    setNodeAt(doc, [...target.path, 'app', 'public'], form.public);
  }
  return true;
}

/**
 * writeStoredValues writes the App's values that are not on the page's form into the member.
 *
 * @param doc the configuration document
 * @param target what the App was created for
 * @param app the App GitHub created
 */
export function writeStoredValues(
  doc: Document,
  target: ManifestTarget,
  app: ConvertedApp,
): boolean {
  const stored = target.stored?.(app) ?? [];
  for (const [path, value] of stored) setNodeAt(doc, [...target.path, ...path], value);
  return stored.length > 0;
}

export class GithubAppManifestService {
  private readonly log: Logger = rootLogger.child('config.github-app');

  constructor(
    private readonly fetchImpl: typeof fetch = fetch, // Overridable for tests
  ) {
    initModels();
  }

  /**
   * start stores the state of a new flow, seals the page's form for the cookie, and builds the manifest of the target's App.
   *
   * @param tenantId the tenant the target belongs to
   * @param target what the App is created for
   * @param owner the organization the App is created on. If it is empty, the App is created on the person's own account
   * @param origin the address of this instance, which GitHub sends the browser back to
   * @param form the page's form, carried to GitHub and back
   */
  async start(
    tenantId: string,
    target: ManifestTarget,
    owner: string,
    origin: string,
    form: CarriedForm,
  ): Promise<{ handoff: ManifestHandoff; sealedForm: string; sealedHandoff: string }> {
    // The cookie holds the form sealed with this key, and only the flow's row holds the key
    const key = randomBytes(32);
    const sealedForm = seal(form, key);
    if (sealedForm.length > MAX_SEALED_FORM) {
      throw new GithubAppManifestError(
        'Your unsaved changes on this page are too large to keep while you create the App on GitHub. Save the page first, then create the App.',
      );
    }

    const configPageUrl = `/-/config/${target.sectionId}`;
    const state = mintToken(24);
    await LoginFlow.create({
      tenant_id: tenantId,
      provider: flowMark(target.sectionId, target.app),
      state,
      // A manifest flow has no nonce; its verifier column holds the key to the carried form
      nonce: mintToken(24),
      code_verifier: key.toString('base64url'),
      redirect_to: configPageUrl,
      names_first_admin: false,
      expires_at: new Date(Date.now() + FLOW_TTL_MS),
    });

    const { web } = githubHosts(target.baseUrl);
    const manifest = target.manifest({
      origin,
      redirectUrl: `${origin}${githubAppCallbackPath(target.sectionId, target.app)}`,
      // GitHub sends the browser here once the App is installed
      setupUrl: `${origin}${target.landsOnReady ? readyPath(target.sectionId) : configPageUrl}`,
    });
    const handoff: ManifestHandoff = {
      manifestPostUrl: manifestFormUrl(web, owner, state),
      manifest,
      web,
      owner,
      configPageUrl,
    };
    // Sealed with the form's key, so the page that posts the manifest takes it from this flow only, unchanged
    return { handoff, sealedForm, sealedHandoff: `${state}.${seal(handoff, key)}` };
  }

  /**
   * handoff opens the manifest a flow sealed for the page that posts it to GitHub. It returns null when the cookie
   * names no open flow of this App, or was changed.
   *
   * @param tenantId the tenant the page belongs to
   * @param sectionId the config page the App is created for
   * @param app which App of the page
   * @param sealedHandoff the cookie the start set
   */
  async handoff(
    tenantId: string,
    sectionId: string,
    app: string,
    sealedHandoff: string,
  ): Promise<ManifestHandoff | null> {
    const cut = sealedHandoff.indexOf('.');
    if (cut <= 0) return null;
    const flow = await LoginFlow.findOne({
      where: {
        tenant_id: tenantId,
        state: sealedHandoff.slice(0, cut),
        provider: flowMark(sectionId, app),
      },
    });
    if (!flow || flow.expires_at.getTime() < Date.now()) return null;
    return open<ManifestHandoff>(
      sealedHandoff.slice(cut + 1),
      Buffer.from(flow.code_verifier, 'base64url'),
    );
  }

  /**
   * claim checks the state GitHub sent back, ends the flow, and opens the form the page carried.
   *
   * @param tenantId the tenant the page belongs to
   * @param sectionId the config page the App is created for
   * @param app which App of the page
   * @param state the state from GitHub's redirect
   * @param sealedForm the form from the cookie
   */
  async claim(
    tenantId: string,
    sectionId: string,
    app: string,
    state: string,
    sealedForm: string,
  ): Promise<CarriedForm> {
    const flow = await LoginFlow.findOne({
      where: { tenant_id: tenantId, state, provider: flowMark(sectionId, app) },
    });
    if (!flow) {
      throw new GithubAppManifestError(
        'The from GitHub returned message does not match an open request from this page. It may already have been used. If the App is not shown on this page, delete the App that GitHub created in its settings on GitHub, then start again on this page.',
      );
    }
    await LoginFlow.destroy({ where: { id: flow.id } });
    if (flow.expires_at.getTime() < Date.now()) {
      throw new GithubAppManifestError(
        'The request to create the App has expired. To create the App, start again on this page.',
      );
    }

    const form = open<CarriedForm>(sealedForm, Buffer.from(flow.code_verifier, 'base64url'));
    if (!form) {
      throw new GithubAppManifestError(
        'The browser came back from GitHub without the details this page sent along. To create the App, start again on this page.',
      );
    }
    return form;
  }

  /**
   * convert exchanges the code GitHub sent back for the App GitHub created.
   *
   * @param target what the App is created for
   * @param code the code from GitHub's redirect
   */
  async convert(target: ManifestTarget, code: string): Promise<ConvertedApp> {
    try {
      return await convertManifestCode(githubHosts(target.baseUrl).api, code, this.fetchImpl);
    } catch (err) {
      this.log.warn('could not convert the manifest code', {
        target: target.sectionId,
        app: target.app,
        error: (err as Error).message,
      });
      throw new GithubAppManifestError(
        'GitHub did not hand over the App. To create the App, start again on this page.',
      );
    }
  }
}

/**
 * flowMark returns what a flow's LoginFlow holds as its provider: the page and the App the flow belongs to.
 *
 * @param sectionId the config page the App is created for
 * @param app which App of the page
 */
function flowMark(sectionId: string, app: string): string {
  return `${FLOW_MARK}${sectionId}/${app}`;
}

/**
 * seal compresses and encrypts what a cookie carries, so it reveals nothing without the key.
 *
 * @param form the carried form, or the hand-off
 * @param key the flow's key
 */
function seal(form: CarriedForm | ManifestHandoff, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([
    cipher.update(deflateRawSync(JSON.stringify(form))),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
}

/**
 * open decrypts what a cookie carries. It returns null when it was not sealed with this key, or was changed.
 *
 * @param sealedForm the form or the hand-off from the cookie
 * @param key the flow's key
 */
function open<T extends CarriedForm | ManifestHandoff>(sealedForm: string, key: Buffer): T | null {
  try {
    const raw = Buffer.from(sealedForm, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = inflateRawSync(
      Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]),
    );
    return JSON.parse(json.toString('utf8')) as T;
  } catch {
    return null;
  }
}
