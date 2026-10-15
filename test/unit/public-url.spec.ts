import { isPublicUrl } from '../../src/common/public-url';
import { appManifest, signInAppName } from '../../src/forge/github/manifest';

describe('whether an address can be reached from the internet', () => {
  it.each([
    'https://docs.acme.example',
    'https://docs.acme.example:8443/-/hooks/gh',
    'http://203.0.113.7:3000',
    'https://[2001:db8::1]/-/hooks/gh',
  ])('takes %s as public', (url) => {
    expect(isPublicUrl(url)).toBe(true);
  });

  it.each([
    'http://localhost:3000',
    'http://docs.localhost',
    'http://speicher.local',
    'http://speicher.internal',
    'http://speicher:3000',
    'http://127.0.0.1:3000',
    'http://0.0.0.0:3000',
    'http://10.1.2.3',
    'http://172.20.0.5',
    'http://192.168.1.10',
    'http://169.254.169.254',
    'http://100.64.0.1',
    'http://[::1]:3000',
    'http://[fd00::1]',
    'http://[fe80::1]',
    'not a url',
    '',
  ])('takes %s as not public', (url) => {
    expect(isPublicUrl(url)).toBe(false);
  });
});

describe("a content source App's manifest", () => {
  const urls = {
    homepage: 'http://localhost:3000',
    redirectUrl: 'http://localhost:3000/-/config/sources/gh/github-app/manifest/callback',
    setupUrl: 'http://localhost:3000/-/config/sources/gh',
  };

  it('subscribes to the events the source acts on when it has a webhook', () => {
    const manifest = appManifest({
      purpose: 'content-source',
      ...urls,
      webhookUrl: 'https://docs.acme.example/-/hooks/gh',
    });
    expect(manifest.hook_attributes).toEqual({
      url: 'https://docs.acme.example/-/hooks/gh',
      active: true,
    });
    expect(manifest.default_events).toEqual(['push', 'pull_request', 'repository']);
  });

  it('has no webhook and no events when GitHub cannot reach the instance', () => {
    const manifest = appManifest({ purpose: 'content-source', ...urls });
    expect(manifest.hook_attributes).toBeUndefined();
    expect(manifest.default_events).toEqual([]);
  });
});

describe("an identity provider App's name", () => {
  it('is the hostname of this instance, then Speicher.md', () => {
    expect(signInAppName('https://docs.acme.example:8443/')).toBe('docs.acme.example Speicher.md');
    expect(signInAppName('http://localhost:3000')).toBe('localhost Speicher.md');
  });

  it("shortens a long hostname to fit GitHub's limit of 34 characters", () => {
    const name = signInAppName('https://documentation.copetence.example');
    expect(name.length).toBeLessThanOrEqual(34);
    expect(name.endsWith(' Speicher.md')).toBe(true);
  });

  it('is Speicher.md alone when the address cannot be read', () => {
    expect(signInAppName('not a url')).toBe('Speicher.md');
  });
});
