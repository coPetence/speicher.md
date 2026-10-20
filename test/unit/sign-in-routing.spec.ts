import {
  catchAllProviders,
  emailDomain,
  hasRoutedProvider,
  providerDomains,
  providersForEmail,
} from '../../src/auth/sign-in-routing';
import { ProviderConfig } from '../../src/config/types';

function lookup(providers: Record<string, ProviderConfig>) {
  return {
    providerShortIds: Object.keys(providers),
    provider: (id: string) => providers[id],
  };
}

const entra: ProviderConfig = {
  issuer: 'https://login.microsoftonline.com/t/v2.0',
  client_id: 'c',
  domains: ['copetence.de', ' @Partner.example '],
};
const hub: ProviderConfig = { type: 'github', client_id: 'c' };
const mail: ProviderConfig = { type: 'magic-link' };
const guests: ProviderConfig = { type: 'magic-link', domains: ['guest.example'] };

describe('the domains of a provider', () => {
  it('lower-cases them and drops a leading @ and blank lines', () => {
    expect(providerDomains({ ...entra, domains: [...entra.domains!, '  '] })).toEqual([
      'copetence.de',
      'partner.example',
    ]);
  });

  it('is empty for a provider offered for every address', () => {
    expect(providerDomains(hub)).toEqual([]);
  });
});

describe('the domain of an address', () => {
  it.each([
    ['Ada@Copetence.DE', 'copetence.de'],
    [' ada@copetence.de ', 'copetence.de'],
    ['"a@b"@copetence.de', 'copetence.de'],
  ])('is %s → %s', (email, domain) => {
    expect(emailDomain(email)).toBe(domain);
  });

  it.each(['ada', '@copetence.de', 'ada@', ''])('is null for %j', (email) => {
    expect(emailDomain(email)).toBeNull();
  });
});

describe('the providers offered for an address', () => {
  const config = lookup({ entra, hub, mail, guests });

  it('are only the ones naming its domain when any does', () => {
    expect(providersForEmail(config, 'ada@copetence.de')).toEqual(['entra']);
    expect(providersForEmail(config, 'bob@partner.example')).toEqual(['entra']);
    expect(providersForEmail(config, 'eve@guest.example')).toEqual(['guests']);
  });

  it('are the magic links offered for every address when none names it', () => {
    expect(providersForEmail(config, 'zoe@elsewhere.example')).toEqual(['mail']);
  });

  it('leave out the buttons offered for every address, which the page shows already', () => {
    expect(providersForEmail(lookup({ entra, hub }), 'zoe@elsewhere.example')).toEqual([]);
  });

  it('are every provider naming the domain, in config order', () => {
    const both = lookup({ hub, entra, second: { ...entra, domains: ['copetence.de'] } });
    expect(providersForEmail(both, 'ada@copetence.de')).toEqual(['entra', 'second']);
  });

  it('are none for an address without a domain', () => {
    expect(providersForEmail(config, 'ada')).toEqual([]);
  });

  it('are none when every provider names other domains', () => {
    expect(providersForEmail(lookup({ entra }), 'zoe@elsewhere.example')).toEqual([]);
  });
});

describe('the catch-all providers', () => {
  it('are those without domains, in config order', () => {
    expect(catchAllProviders(lookup({ entra, hub, guests, mail }))).toEqual(['hub', 'mail']);
  });

  it('notice whether any provider is routed by domain', () => {
    expect(hasRoutedProvider(lookup({ hub, mail }))).toBe(false);
    expect(hasRoutedProvider(lookup({ hub, entra }))).toBe(true);
  });
});
