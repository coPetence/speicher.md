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
import { choiceName } from '../config-form/config-fields';
import { setNodeAt } from '../config-form/document';
import { memberSectionId } from '../config-form/members';
import type { Uploads } from '../config-form/upload';

const FLOW_MARK = 'github-app:';

// Holds the page's form, sealed, while the browser is on GitHub
export const GITHUB_APP_FORM_COOKIE = 'speicher_github_app_form';

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
  manifest: (urls: ManifestUrls) => AppManifest;
  values: (app: ConvertedApp) => [string[], string][];
  stored?: (app: ConvertedApp) => [string[], unknown][];
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
      [['app_id'], String(app.id)],
      [['private_key'], app.pem],
      // An App created without a webhook has no secret, and the source needs one
      [['webhook_secret'], app.webhook_secret ?? mintToken(32)],
    ],
    unsavedNotice: (installUrl) =>
      `App successfully created, but this page could not be saved yet. The App's credentials are filled in below. Fix the problems on this page and save it, then [install the App](${installUrl}) on the repositories Speicher.md should be able to read.`,
  };
}

/**
 * identityProviderTarget returns the target of the App of a new GitHub identity provider.
 *
 * @param providerId the id of the identity provider
 * @param baseUrl the base URL of a GitHub Enterprise Server. If it is empty, the App is created on GitHub.com
 */
export function identityProviderTarget(providerId: string, baseUrl = ''): ManifestTarget {
  return {
    sectionId: memberSectionId('identity', providerId),
    app: 'github-app',
    path: ['auth', 'providers', providerId],
    member: 'new',
    kind: 'github',
    baseUrl: baseUrl || undefined,
    switchName: choiceName(`auth.providers.${providerId}.app`),
    manifest: ({ origin, redirectUrl, setupUrl }) =>
      appManifest({
        purpose: 'identity-provider',
        homepage: origin,
        callbackUrl: `${origin}${GITHUB_CALLBACK_PATH}`,
        redirectUrl,
        setupUrl,
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
      `App successfully created, but this page could not be saved yet. The App's credentials are filled in below. Fix the problems on this page and save it, then [install the App](${installUrl}) on the organization whose members should be able to sign in, so Speicher.md can read their teams.`,
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
    manifest: ({ origin, redirectUrl, setupUrl }) =>
      appManifest({ purpose: 'directory', homepage: origin, redirectUrl, setupUrl }),
    values: (app) => [
      [['directory', 'app_id'], String(app.id)],
      [['directory', 'private_key'], app.pem],
    ],
    unsavedNotice: (installUrl) =>
      `App successfully created, but this page could not be saved yet. The App's id and private key are filled in below. Fix the problems on this page and save it, then [install the App](${installUrl}) on every organization whose members and teams Speicher.md should look up.`,
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
  ): Promise<{ handoff: ManifestHandoff; sealedForm: string }> {
    // The cookie holds the form sealed with this key, and only the flow's row holds the key
    const key = randomBytes(32);
    const sealedForm = seal(form, key);
    if (sealedForm.length > MAX_SEALED_FORM) {
      throw new GithubAppManifestError(
        'This page holds more than Speicher can carry to GitHub and back. Save the page first, then create the App.',
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
      setupUrl: `${origin}${configPageUrl}`,
    });
    return {
      handoff: {
        manifestPostUrl: manifestFormUrl(web, owner, state),
        manifest,
        web,
        owner,
        configPageUrl,
      },
      sealedForm,
    };
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
        'Speicher does not know this answer from GitHub, or has already used it. To create the App, start again on this page.',
      );
    }
    await LoginFlow.destroy({ where: { id: flow.id } });
    if (flow.expires_at.getTime() < Date.now()) {
      throw new GithubAppManifestError(
        'The request to create the App has expired. To create the App, start again on this page.',
      );
    }

    const form = open(sealedForm, Buffer.from(flow.code_verifier, 'base64url'));
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
 * seal compresses and encrypts the carried form, so the cookie reveals nothing without the key.
 *
 * @param form the carried form
 * @param key the flow's key
 */
function seal(form: CarriedForm, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([
    cipher.update(deflateRawSync(JSON.stringify(form))),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
}

/**
 * open decrypts a sealed form. It returns null when the form was not sealed with this key, or was changed.
 *
 * @param sealedForm the form from the cookie
 * @param key the flow's key
 */
function open(sealedForm: string, key: Buffer): CarriedForm | null {
  try {
    const raw = Buffer.from(sealedForm, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = inflateRawSync(
      Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]),
    );
    return JSON.parse(json.toString('utf8')) as CarriedForm;
  } catch {
    return null;
  }
}
