/**
 * Creates a button that starts the manifest flow of a GitHub source.
 */

export interface GithubAppManifestItem {
  kind: 'github-app-manifest';
  // Where the button sends the form to start the manifest flow
  action: string;
  // The organization the App is created on
  owner: string;
  // Markdown of a note shown below the button, e.g. that GitHub cannot reach this
  // instance; empty when there is nothing to note
  note: string;
  // The form name of the organization input, `<app>:owner`, distinct for each App on a page
  ownerName: string;
  account?: GithubAppAccount & { name: string };
}

export interface GithubAppAccount {
  label: string;
  organization: string;
  personal: string;
}

export const SOURCE_ACCOUNT: GithubAppAccount = {
  label: 'Which repositories do you want to sync',
  organization: 'From an organization',
  personal: 'From my personal account',
};

/**
 * githubAppManifest builds the button that starts the manifest flow of a GitHub App.
 *
 * @param action the URL the button sends the form to
 * @param owner the organization the input is prefilled with
 * @param note the markdown of the note shown below the button
 * @param app which App of the page the button creates, e.g. `github-app`
 * @param account picks the account the app should be installed on
 */
export function githubAppManifest(
  action: string,
  owner: string,
  note = '',
  app = 'github-app',
  account?: GithubAppAccount,
): GithubAppManifestItem {
  return {
    kind: 'github-app-manifest',
    action,
    owner,
    note,
    ownerName: `${app}:owner`,
    ...(account ? { account: { ...account, name: `${app}:account` } } : {}),
  };
}
