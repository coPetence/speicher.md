// Supported until 10 March 2028
// We use an older version because GitHub Enterprise servers often lag
export const GITHUB_API_VERSION = '2022-11-28';

export function githubHeaders(token?: string): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}
