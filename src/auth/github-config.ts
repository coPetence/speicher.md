import { GithubProviderConfig } from '../config/types';

export function githubProviderProblems(
  providerKey: string,
  provider: GithubProviderConfig,
): string[] {
  const at = `auth.providers.${providerKey}`;

  if (!provider.client_secret) {
    return [`${at}.client_secret is required`];
  }

  return [];
}
