import { GithubProviderConfig } from '../config/types';

export function githubProviderProblems(
  providerShortId: string,
  provider: GithubProviderConfig,
): string[] {
  const at = `auth.providers.${providerShortId}`;

  if (!provider.client_secret) {
    return [`${at}.client_secret is required`];
  }

  return [];
}
