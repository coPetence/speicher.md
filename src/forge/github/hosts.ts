/**
 * The web and API addresses of GitHub.com, or of a GitHub Enterprise Server
 */

export const GITHUB_WEB = 'https://github.com';
export const GITHUB_API = 'https://api.github.com';

export interface GithubHosts {
  web: string;
  api: string;
}

/**
 * githubHosts returns the web and API addresses of a GitHub instance.
 *
 * @param baseUrl the base URL of a GitHub Enterprise Server. If it is empty, the addresses of GitHub.com are returned
 */
export function githubHosts(baseUrl?: string): GithubHosts {
  const base = baseUrl?.replace(/\/+$/, '');
  if (!base) return { web: GITHUB_WEB, api: GITHUB_API };
  return { web: base, api: `${base}/api/v3` };
}
