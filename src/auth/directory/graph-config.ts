import { DirectoryConfig, OidcProviderConfig } from '../../config/types';

// TODO check wether this makes sense for other OIDC providers than Microsoft
export function graphDirectoryProblems(
  providerShortId: string,
  provider: OidcProviderConfig,
): string[] {
  const directory = provider.directory;
  if (!directory) return [];

  const at = `auth.providers.${providerShortId}`;
  if (directory.type !== 'graph') {
    return [`${at}.directory.type must be "graph" for an oidc provider`];
  }

  const problems: string[] = [];

  for (const key of CREDENTIAL_CONFIG_KEYS) {
    if (!directory[key]) {
      problems.push(`${at}.directory.${key} is required for a Microsoft Graph directory`);
    }
  }

  /*
    Graph only resolves using oid. if something else is used as subject (can be configured in adv. settings) directory client cannot work
  */
  const claim = provider.subject_claim ?? 'sub';
  if (claim !== 'oid') {
    problems.push(
      `${at}: The subject_claim must be "oid" to use a Microsoft Graph directory, but it is "${claim}". Set subject_claim to "oid", or remove the \`directory\` block.`,
    );
  }

  return problems;
}

const CREDENTIAL_CONFIG_KEYS: (keyof DirectoryConfig)[] = ['tenant_id', 'client_id', 'client_secret'];
