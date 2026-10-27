import { githubDirectoryProblems } from '../../auth/directory/github-config';
import { entraProviderProblems } from '../../auth/entra-config';
import { githubProviderProblems } from '../../auth/github-config';
import { graphDirectoryProblems } from '../../auth/directory/graph-config';
import { SETUP_PROVIDER } from '../../common/principals';
import {
  GithubProviderConfig,
  InstanceConfig,
  OidcProviderConfig,
  ProviderConfig,
  providerType,
} from '../types';
import { ConfigProblem, problem } from '../../common/config-problems';

export function checkProviders(config: InstanceConfig, problems: ConfigProblem[]): void {
  const providers = config.auth?.providers ?? {};
  const ids = Object.keys(providers);

  const usesMagicLink = ids.find((id) => providerType(providers[id]) === 'magic-link');
  if (usesMagicLink !== undefined && !config.mail) {
    problems.push(
      problem('providers.magic-link-needs-mail', `auth.providers.${usesMagicLink}`, {
        text: 'Mail is not configured. Configure `mail` for magic-link sign-in.',
        dashboard:
          'Mail is not configured. Set up [Mail transport](/-/config/mail) for magic-link sign-in.',
      }),
    );
  }

  const defaultProvider = config.auth?.default_provider;
  if (defaultProvider !== undefined && !providers[defaultProvider]) {
    problems.push(
      problem('providers.unknown-default', 'auth.default_provider', {
        text: `Default provider "${defaultProvider}" does not exist. Select an existing provider.`,
        dashboard: `Default provider "${defaultProvider}" does not exist. Select an existing provider.`,
      }),
    );
  }

  // Reserve the setup name to block setup-session access
  const setupProvider = ids.find((id) => id.toLowerCase() === SETUP_PROVIDER);
  if (setupProvider !== undefined) {
    problems.push(
      problem('names.reserved', `auth.providers.${setupProvider}`, {
        text: `Provider name "${setupProvider}" is reserved. Use a different name.`,
        dashboard: `Provider name "${setupProvider}" is reserved. Use a different name.`,
      }),
    );
  }

  for (const id of ids) {
    const provider: ProviderConfig = providers[id];
    if (providerType(provider) === 'oidc') {
      problems.push(...entraProviderProblems(id, provider as OidcProviderConfig));
      problems.push(...graphDirectoryProblems(id, provider as OidcProviderConfig));
    }
    if (providerType(provider) === 'github') {
      problems.push(...githubProviderProblems(id, provider as GithubProviderConfig));
      problems.push(...githubDirectoryProblems(id, provider as GithubProviderConfig));
    }
  }
}
