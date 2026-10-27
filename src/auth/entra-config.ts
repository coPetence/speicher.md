import { ConfigProblem, problem } from '../common/config-problems';
import { OidcProviderConfig } from '../config/types';

// Entra cloud hosts and External ID suffixes
const ENTRA_HOSTS = [
  'login.microsoftonline.com',
  'login.microsoftonline.us',
  'login.partner.microsoftonline.cn',
  'login.chinacloudapi.cn',
];
const ENTRA_HOST_SUFFIXES = ['.ciamlogin.com'];

/** Checks whether the issuer uses an Entra host */
export function isEntraIssuer(issuer: string): boolean {
  let host: string;
  try {
    host = new URL(issuer).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ENTRA_HOSTS.includes(host) || ENTRA_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

export function entraProviderProblems(
  providerShortId: string,
  provider: OidcProviderConfig,
): ConfigProblem[] {
  if (!isEntraIssuer(provider.issuer)) return [];

  // Entra requires a secret for server-side code redemption (AADSTS7000218)
  if (!provider.client_secret) {
    return [
      problem(
        'providers.client-secret-missing',
        `auth.providers.${providerShortId}.client_secret`,
        {
          text: 'is required for an Entra ID provider. Create one under Certificates & secrets in the app registration.',
          dashboard:
            'Entra ID needs a client secret. Create one under Certificates & secrets in the app registration.',
        },
      ),
    ];
  }

  return [];
}
