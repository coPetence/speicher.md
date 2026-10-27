import { ConfigProblem, problem } from '../../common/config-problems';
import { DirectoryConfig, OidcProviderConfig } from '../../config/types';

// TODO: Verify non-Microsoft OIDC support
export function graphDirectoryProblems(
  providerShortId: string,
  provider: OidcProviderConfig,
): ConfigProblem[] {
  const directory = provider.directory;
  if (!directory) return [];

  const at = `auth.providers.${providerShortId}`;
  if (directory.type !== 'graph') {
    return [
      problem('providers.directory-wrong-type', `${at}.directory.type`, {
        text: 'must be "graph" for OpenID Connect',
        dashboard: 'Set the directory type to "graph" for OpenID Connect.',
      }),
    ];
  }

  const problems: ConfigProblem[] = [];

  for (const key of CREDENTIAL_CONFIG_KEYS) {
    if (!directory[key]) {
      problems.push(
        problem('providers.directory-key-missing', `${at}.directory.${key}`, {
          text: 'is required for Microsoft Graph',
          dashboard: `Missing "${key}" for Microsoft Graph.`,
        }),
      );
    }
  }

  // Graph identifies users by the "oid" claim
  const claim = provider.subject_claim ?? 'sub';
  if (claim !== 'oid') {
    problems.push(
      problem('providers.directory-needs-oid', `${at}.subject_claim`, {
        text: `must be "oid", not "${claim}", for Microsoft Graph`,
        dashboard: `Set the subject claim to "oid" (currently "${claim}") or disable the Microsoft Graph directory.`,
      }),
    );
  }

  return problems;
}

const CREDENTIAL_CONFIG_KEYS: (keyof DirectoryConfig)[] = [
  'tenant_id',
  'client_id',
  'client_secret',
];
