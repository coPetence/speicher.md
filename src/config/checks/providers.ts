import { githubDirectoryProblems } from '../../auth/directory/github-config';
import { graphDirectoryProblems } from '../../auth/directory/graph-config';
import { SETUP_PROVIDER } from '../../common/principals';
import {
  GithubProviderConfig,
  InstanceConfig,
  OidcProviderConfig,
  ProviderConfig,
  providerType,
} from '../types';

export function checkProviders(config: InstanceConfig, problems: string[]): void {
  const providers = config.auth?.providers ?? {};
  const ids = Object.keys(providers);

  const usesMagicLink = ids.find((id) => providerType(providers[id]) === 'magic-link');
  if (usesMagicLink !== undefined && !config.mail) {
    problems.push(
      `auth.providers.${usesMagicLink}: A magic-link provider signs people in by sending them a link by email, but this instance has no mail transport configured. Set up the [Mail transport](/-/config/mail) first, then add the provider.`,
    );
  }

  const defaultProvider = config.auth?.default_provider;
  if (defaultProvider !== undefined && !providers[defaultProvider]) {
    problems.push(`auth.default_provider "${defaultProvider}" is not a configured provider`);
  }

  // The setup session uses this provider name, so a configured provider with the
  // same name would make that session grantable
  const setupProvider = ids.find((id) => id.toLowerCase() === SETUP_PROVIDER);
  if (setupProvider !== undefined) {
    problems.push(`auth.providers.${setupProvider} is reserved. Rename the provider.`);
  }

  for (const id of ids) {
    const provider: ProviderConfig = providers[id];
    if (providerType(provider) === 'oidc') {
      problems.push(...graphDirectoryProblems(id, provider as OidcProviderConfig));
    }
    if (providerType(provider) === 'github') {
      problems.push(...githubDirectoryProblems(id, provider as GithubProviderConfig));
    }
  }
}
