/**
 * Creating a GitHub App from a manifest
 *
 * GitHub's manifest flow: the browser posts a manifest to GitHub, the person confirms
 * the App there, and GitHub sends the browser back with a code. The code is
 * exchanged once for the App's id, private key and webhook secret.
 * See https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */

import { githubHeaders } from './api';
import type { GithubAppOwner } from './app-links';

const CONTENT_SOURCE_PERMISSIONS = {
  contents: 'read',
  metadata: 'read',
  pull_requests: 'read',
  checks: 'write',
};

const CONTENT_SOURCE_EVENTS = ['push', 'pull_request', 'repository'];

const IDENTITY_PROVIDER_PERMISSIONS = {
  members: 'read',
  emails: 'read',
};

const SPEICHER_DESCRIPTION =
  'speicher.md is a tool for sharing your Markdown files, for documentation or from your Obsidian vault. It uses simple Git repositories as the source, so your files stay under version control. You can share the files publicly, or with groups and single people who sign in with one of the supported identity providers (GitHub, Microsoft Entra, Google), so nobody needs an account on speicher.md. Every page is plain HTML and CSS and works without JavaScript, and the speicher.md MCP server lets your AI agent use the documentation as context.';

const CONTENT_SOURCE_DESCRIPTION = `${SPEICHER_DESCRIPTION}\n\nThis App gives speicher.md read access to the repositories it is installed on. speicher.md reads their Markdown files, updates its pages whenever a change is pushed, and checks the \`.speicher.yaml\` in pull requests.`;

const IDENTITY_PROVIDER_DESCRIPTION = `${SPEICHER_DESCRIPTION}\n\nThis App lets people sign in to speicher.md with their GitHub account. Access can then be granted to their GitHub teams, or to them by email address.`;

const DIRECTORY_PERMISSIONS = {
  members: 'read',
};

const DIRECTORY_EVENTS = ['membership', 'team', 'organization'];

const DIRECTORY_DESCRIPTION = `${SPEICHER_DESCRIPTION}\n\nThis App lets speicher.md look up the members and teams of the organizations it is installed on. speicher.md uses this to notice when someone leaves a team or the organization during their session, and to show how many people a team grant reaches.`;

export interface AppManifest {
  name: string;
  description: string;
  url: string;
  hook_attributes?: { url: string; active: boolean };
  redirect_url: string;
  callback_urls?: string[];
  setup_url: string;
  setup_on_update: boolean;
  // Asks the person installing the App to sign in with it, and then sends them to the callback, not the setup URL
  request_oauth_on_install?: boolean;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

interface AppManifestBase {
  // The address of this instance
  homepage: string;
  redirectUrl: string;
  // Where GitHub sends the browser after the App is installed
  setupUrl: string;
}

export interface ContentSourceAppOptions extends AppManifestBase {
  purpose: 'content-source';
  // Absent when GitHub cannot reach this instance, so the App is created without a webhook
  webhookUrl?: string;
}

export interface IdentityProviderAppOptions extends AppManifestBase {
  purpose: 'identity-provider';
  callbackUrl: string;
  // Lets anyone with a GitHub account sign in; a private App takes only the members of its owner
  public?: boolean;
  // Signs the person installing the App in as they install it
  signInOnInstall?: boolean;
}

export interface DirectoryAppOptions extends AppManifestBase {
  purpose: 'directory';
  webhookUrl?: string;
}

export type AppManifestOptions =
  | ContentSourceAppOptions
  | IdentityProviderAppOptions
  | DirectoryAppOptions;

// GitHub refuses an App name that is longer
const MAX_APP_NAME = 34;

/**
 * signInAppName returns the name of an identity provider's App: the hostname of this instance, then `speicher.md`.
 * A hostname too long for GitHub's limit on App names is shortened.
 *
 * @param homepage the address of this instance
 */
export function signInAppName(homepage: string): string {
  const suffix = ' speicher.md';
  let host: string;
  try {
    host = new URL(homepage).hostname;
  } catch {
    return suffix.trim();
  }
  return `${host.slice(0, MAX_APP_NAME - suffix.length)}${suffix}`;
}

/**
 * appManifest builds the manifest of a GitHub App for a content source, an identity provider or a directory lookup.
 *
 * @param options what the App is for, and the addresses it points at
 */
export function appManifest(options: AppManifestOptions): AppManifest {
  const base = {
    url: options.homepage,
    redirect_url: options.redirectUrl,
    setup_url: options.setupUrl,
    setup_on_update: true,
    public: false,
  };
  if (options.purpose === 'identity-provider') {
    return {
      ...base,
      public: options.public === true,
      ...(options.signInOnInstall ? { request_oauth_on_install: true } : {}),
      name: signInAppName(options.homepage),
      description: IDENTITY_PROVIDER_DESCRIPTION,
      callback_urls: [options.callbackUrl],
      default_permissions: IDENTITY_PROVIDER_PERMISSIONS,
      default_events: [],
    };
  }
  if (options.purpose === 'directory') {
    return {
      ...base,
      ...webhookOf(options.webhookUrl, DIRECTORY_EVENTS),
      name: 'speicher.md Directory',
      description: DIRECTORY_DESCRIPTION,
      default_permissions: DIRECTORY_PERMISSIONS,
    };
  }
  return {
    ...base,
    ...webhookOf(options.webhookUrl, CONTENT_SOURCE_EVENTS),
    name: 'speicher.md',
    description: CONTENT_SOURCE_DESCRIPTION,
    default_permissions: CONTENT_SOURCE_PERMISSIONS,
  };
}

function webhookOf(
  url: string | undefined,
  events: string[],
): Pick<AppManifest, 'hook_attributes' | 'default_events'> {
  return url
    ? { hook_attributes: { url, active: true }, default_events: events }
    : { default_events: [] };
}

/**
 * manifestFormUrl returns the page on GitHub the manifest is posted to.
 *
 * @param web the web address of the GitHub instance
 * @param owner the organization the App is created on. If it is empty, the App is created on the person's own account
 * @param state the value GitHub hands back with the code, to tie the code to this flow
 */
export function manifestFormUrl(web: string, owner: string, state: string): string {
  const path =
    owner === ''
      ? '/settings/apps/new'
      : `/organizations/${encodeURIComponent(owner)}/settings/apps/new`;
  const url = new URL(`${web}${path}`);
  url.searchParams.set('state', state);
  return url.toString();
}

export interface ConvertedApp {
  id: number;
  slug: string;
  owner: GithubAppOwner | null;
  // The App's page on GitHub, e.g. `https://github.com/apps/speicher-md`
  html_url: string;
  pem: string;
  webhook_secret: string | null;
  // The App's OAuth credentials
  client_id: string;
  client_secret: string;
}

/**
 * convertManifestCode exchanges the code GitHub sent back for the App's credentials.
 * The code can be exchanged only once and expires after an hour.
 *
 * @param api the API address of the GitHub instance
 * @param code the code from the redirect
 * @param fetchImpl the fetch to call GitHub with
 */
export async function convertManifestCode(
  api: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConvertedApp> {
  const response = await fetchImpl(`${api}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: githubHeaders(),
  });
  if (!response.ok) {
    throw new Error(`GitHub did not accept the code: ${response.status} ${response.statusText}`);
  }

  const app = (await response.json()) as Partial<Omit<ConvertedApp, 'owner'>> & {
    owner?: { login?: unknown; type?: unknown } | null;
  };
  if (
    typeof app.id !== 'number' ||
    typeof app.pem !== 'string' ||
    typeof app.html_url !== 'string'
  ) {
    throw new Error('GitHub sent the App without its id, private key or address');
  }
  return {
    id: app.id,
    slug: app.slug ?? '',
    owner:
      typeof app.owner?.login === 'string'
        ? { accountName: app.owner.login, isOrganization: app.owner.type === 'Organization' }
        : null,
    html_url: app.html_url,
    pem: app.pem,
    webhook_secret: typeof app.webhook_secret === 'string' ? app.webhook_secret : null,
    client_id: app.client_id ?? '',
    client_secret: app.client_secret ?? '',
  };
}
