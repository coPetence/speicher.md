import { DirectoryConfig, OidcProviderConfig } from '../../config/types';

// TODO check wether this makes sense for other OIDC providers than Microsoft
export function graphDirectoryProblems(
  providerKey: string,
  provider: OidcProviderConfig,
): string[] {
  const directory = provider.directory;
  if (!directory) return [];

  const at = `auth.providers.${providerKey}`;
  if (directory.type !== 'graph') {
    return [`${at}.directory.type must be "graph" for an oidc provider`];
  }

  const problems: string[] = [];

  for (const key of CREDENTIALS) {
    if (!directory[key]) {
      problems.push(`${at}.directory.${key} is required for a Microsoft Graph directory`);
    }
  }

  /*
    Graph answers with the directory object id, so a subject resolved through it only
    matches a grant whose subject *is* that id. A per-application claim would resolve
    to a principal no grant could name.
  */
  const claim = provider.subject_claim ?? 'sub';
  if (claim !== 'oid') {
    problems.push(
      `${at}: The subject_claim must be "oid" to use a Microsoft Graph directory, but it is "${claim}". Set subject_claim to "oid", or remove the \`directory\` block.`,
    );
  }

  return problems;
}

/** The three an app registration needs to mint a client-credentials token */
const CREDENTIALS: (keyof DirectoryConfig)[] = ['tenant_id', 'client_id', 'client_secret'];
