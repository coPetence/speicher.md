import { ConfigProblem, problem } from '../common/config-problems';
import { GithubProviderConfig } from '../config/types';

export function githubProviderProblems(
  providerShortId: string,
  provider: GithubProviderConfig,
): ConfigProblem[] {
  if (!provider.client_secret) {
    return [
      problem(
        'providers.client-secret-missing',
        `auth.providers.${providerShortId}.client_secret`,
        {
          text: 'is required',
          dashboard: 'A GitHub provider needs its client secret.',
        },
      ),
    ];
  }

  return [];
}
