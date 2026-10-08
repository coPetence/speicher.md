import { SETUP_PROVIDER } from '../../common/principals';
import { DirectoryConfig, InstanceConfig, ProviderConfig, providerType } from '../types';

/**
 * checkProviders checks the sign-in providers: a magic-link provider needs the mail
 * transport, `default_provider` must exist, the setup provider name is reserved,
 * and a directory must fit the provider's type.
 *
 * @param config the loaded instance config
 * @param problems the list that problems are added to
 */
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
      checkGraphDirectory(id, provider, problems);
    }
    if (providerType(provider) === 'github') {
      const gh = provider as { directory?: { type: string } };
      if (gh.directory && gh.directory.type !== 'github') {
        problems.push(`auth.providers.${id}.directory.type must be "github" for a github provider`);
      }
    }
  }
}

// TODO check wether this makes sense for other OIDC providers than Microsoft
/**
 * checkGraphDirectory checks the directory of an OIDC provider: it must be a
 * Microsoft Graph directory with its three credentials, and the provider must use
 * `oid` as its subject claim, since Graph answers with the object id.
 *
 * @param id the provider's id
 * @param provider the OIDC provider
 * @param problems the list that problems are added to
 */
function checkGraphDirectory(id: string, provider: ProviderConfig, problems: string[]): void {
  const oidc = provider as { subject_claim?: string; directory?: DirectoryConfig };
  if (!oidc.directory) return;
  if (oidc.directory.type !== 'graph') {
    problems.push(`auth.providers.${id}.directory.type must be "graph" for an oidc provider`);
    return;
  }
  for (const key of ['tenant_id', 'client_id', 'client_secret'] as const) {
    if (!oidc.directory[key]) {
      problems.push(
        `auth.providers.${id}.directory.${key} is required for a Microsoft Graph directory`,
      );
    }
  }
  const claim = oidc.subject_claim ?? 'sub';
  if (claim !== 'oid') {
    problems.push(
      `auth.providers.${id}: The subject_claim must be "oid" to use a Microsoft Graph directory, but it is "${claim}". Set subject_claim to "oid", or remove the \`directory\` block.`,
    );
  }
}
