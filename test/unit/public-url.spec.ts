import { isLocalhostUrl, isPublicUrl } from '../../src/common/public-url';
import { appCard } from '../../src/dashboard/configurator/config-form/sections/content-sources/github-app-card';
import { appManifest, signInAppName } from '../../src/github/app-manifest';

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

describe('whether an address is this machine', () => {
  it.each([
    'http://localhost:3000',
    'http://docs.localhost',
    'http://127.0.0.1:3000',
    'http://127.1.2.3',
    'http://[::1]:3000',
  ])('takes %s as localhost', (url) => {
    expect(isLocalhostUrl(url)).toBe(true);
  });

  it.each([
    'https://docs.acme.example',
    'http://speicher.local',
    'http://speicher:3000',
    'http://10.1.2.3',
    'http://[fd00::1]',
    'not a url',
    '',
  ])('takes %s as not localhost', (url) => {
    expect(isLocalhostUrl(url)).toBe(false);
  });
});

describe('the note beside the button that creates a source App', () => {
  const noteFor = (publicUrl: string | undefined, baseUrl = ''): string => {
    const before = process.env.SPEICHER_PUBLIC_URL;
    if (publicUrl === undefined) delete process.env.SPEICHER_PUBLIC_URL;
    else process.env.SPEICHER_PUBLIC_URL = publicUrl;
    try {
      const forge = { type: 'github', ...(baseUrl ? { base_url: baseUrl } : {}) };
      const found = JSON.stringify(appCard({ forges: { gh: forge } }, 'gh'));
      return /"kind":"github-app-manifest"[^}]*"note":"([^"]*)"/.exec(found)?.[1] ?? '';
    } finally {
      if (before === undefined) delete process.env.SPEICHER_PUBLIC_URL;
      else process.env.SPEICHER_PUBLIC_URL = before;
    }
  };

  it('says nothing for a public address', () => {
    expect(noteFor('https://docs.acme.example')).toBe('');
  });

  it('says the App gets no webhook on localhost, whatever GitHub it is created on', () => {
    expect(noteFor('http://localhost:3000')).toContain('without a webhook');
    expect(noteFor('http://localhost:3000', 'https://ghe.acme.example')).toContain(
      'without a webhook',
    );
  });

  it('warns that GitHub may not reach a private or unknown address', () => {
    expect(noteFor('http://speicher.internal')).toContain('may not be able to reach');
    expect(noteFor('http://10.1.2.3')).toContain('may not be able to reach');
    expect(noteFor(undefined)).toContain('may not be able to reach');
  });

  it('does not warn for a GitHub Enterprise Server, which may run in the same network', () => {
    expect(noteFor('http://speicher.internal', 'https://ghe.acme.example')).toBe('');
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

describe("a directory App's manifest", () => {
  const urls = {
    homepage: 'https://docs.acme.example',
    redirectUrl:
      'https://docs.acme.example/-/config/identity/hub/github-directory-app/manifest/callback',
    setupUrl: 'https://docs.acme.example/-/config/identity/hub',
  };

  it('subscribes to changes of teams and members when it has a webhook', () => {
    const manifest = appManifest({
      purpose: 'directory',
      ...urls,
      webhookUrl: 'https://docs.acme.example/-/hooks/directory/hub',
    });
    expect(manifest.hook_attributes).toEqual({
      url: 'https://docs.acme.example/-/hooks/directory/hub',
      active: true,
    });
    expect(manifest.default_events).toEqual(['membership', 'team', 'organization']);
  });

  it('has no webhook and no events without one', () => {
    const manifest = appManifest({ purpose: 'directory', ...urls });
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
