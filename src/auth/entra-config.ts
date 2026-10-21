import { OidcProviderConfig } from '../config/types';

// Entra authorities: public, US Government and China clouds, and External ID tenants
const ENTRA_HOSTS = [
  'login.microsoftonline.com',
  'login.microsoftonline.us',
  'login.partner.microsoftonline.cn',
  'login.chinacloudapi.cn',
];
const ENTRA_HOST_SUFFIXES = ['.ciamlogin.com'];

/** Whether an OIDC issuer URL belongs to Microsoft Entra ID */
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
): string[] {
  if (!isEntraIssuer(provider.issuer)) return [];

  /*
    without a secret we get error AADSTS7000218 because we redeem the code server side. 
    The secret is optional in the config because it is not needed for public clients, but Entra requires it.
  */
  if (!provider.client_secret) {
    return [
      `auth.providers.${providerShortId}.client_secret is required for an Entra ID provider. Create one under Certificates & secrets in the app registration.`,
    ];
  }

  return [];
}
