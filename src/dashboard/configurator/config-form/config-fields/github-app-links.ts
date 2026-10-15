/**
 * Links to a GitHub App's settings page and installation page on GitHub
 */

export interface GithubAppLinksItem {
  kind: 'github-app-links';
  // Where the App's id and private key are stored, e.g. `['forges', 'gh']`. The links are
  // looked up on GitHub from them when the page is drawn. Empty when the links are known
  lookup: string[];
  // The base URL of the GitHub Enterprise Server the App is on; empty for GitHub.com
  baseUrl: string;
  // The App's settings page; empty until it is known
  settingsUrl: string;
  // The page that installs the App; empty until it is known
  installUrl: string;
}

export interface GithubAppLinksOptions {
  lookup?: string[];
  baseUrl?: string;
  settingsUrl?: string;
  installUrl?: string;
}

/**
 * githubAppLinksItem builds the links to a GitHub App's settings page and installation page.
 * If the links are not known yet, `lookup` names where the App's credentials are stored.
 *
 * @param options the links, or where to look them up
 */
export function githubAppLinksItem(options: GithubAppLinksOptions): GithubAppLinksItem {
  return {
    kind: 'github-app-links',
    lookup: options.lookup ?? [],
    baseUrl: options.baseUrl ?? '',
    settingsUrl: options.settingsUrl ?? '',
    installUrl: options.installUrl ?? '',
  };
}
