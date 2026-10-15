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
}

/**
 * githubAppManifest builds the button that starts the manifest flow of a GitHub source.
 *
 * @param action the URL the button sends the form to
 * @param owner the organization the input is prefilled with
 * @param note the markdown of the note shown below the button
 */
export function githubAppManifest(action: string, owner: string, note = ''): GithubAppManifestItem {
  return { kind: 'github-app-manifest', action, owner, note };
}
