/**
 * Decide which providers the sign-in page offers for an email address
 */

import type { ConfigService } from '../config/config.service';
import { ProviderConfig, providerType } from '../config/types';

type ProviderLookup = Pick<ConfigService, 'providerShortIds' | 'provider'>;

export function providerDomains(provider: ProviderConfig): string[] {
  return (provider.domains ?? [])
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter((domain) => domain !== '');
}

export function emailDomain(email: string): string | null {
  const at = email.trim().lastIndexOf('@');
  if (at <= 0) return null;
  const domain = email
    .trim()
    .slice(at + 1)
    .toLowerCase();
  return domain === '' ? null : domain;
}

export function catchAllProviders(config: ProviderLookup): string[] {
  return config.providerShortIds.filter((id) => {
    const provider = config.provider(id);
    return provider !== undefined && providerDomains(provider).length === 0;
  });
}

export function hasRoutedProvider(config: ProviderLookup): boolean {
  return config.providerShortIds.some((id) => {
    const provider = config.provider(id);
    return provider !== undefined && providerDomains(provider).length > 0;
  });
}

export function providersForEmail(config: ProviderLookup, email: string): string[] {
  const domain = emailDomain(email);
  if (domain === null) return [];
  const matched = config.providerShortIds.filter((id) => {
    const provider = config.provider(id);
    return provider !== undefined && providerDomains(provider).includes(domain);
  });
  if (matched.length > 0) return matched;
  return catchAllProviders(config).filter(
    (id) => providerType(config.provider(id)!) === 'magic-link',
  );
}
