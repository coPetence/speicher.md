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
 * @param baseUrl the base URL of a GitHub Enterprise Server. If it is empty, or names GitHub.com itself, the addresses of GitHub.com are returned
 */
export function githubHosts(baseUrl?: string): GithubHosts {
  const base = baseUrl?.trim().replace(/\/+$/, '');
  if (!base || isGithubCom(base)) return { web: GITHUB_WEB, api: GITHUB_API };
  return { web: base, api: `${base}/api/v3` };
}

/**
 * isGithubCom returns whether a base URL names GitHub.com, whose API is not under `/api/v3` like a GitHub Enterprise Server's.
 *
 * @param baseUrl the base URL
 */
function isGithubCom(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'github.com' || host === 'www.github.com' || host === 'api.github.com';
  } catch {
    return false;
  }
}
