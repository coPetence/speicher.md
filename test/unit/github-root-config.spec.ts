import { RemoteRepo } from '../../src/forge/driver';
import { GithubDriver } from '../../src/forge/github/github.driver';

const REPO: RemoteRepo = {
  forgeRepoId: '42',
  namespace: 'copetence',
  namespaceId: '9001',
  name: 'handbook',
  defaultBranch: 'main',
  private: true,
  archived: false,
  installationId: '7',
};

// Answers the token request, then the root listing with the given status and entries
function driverAnswering(status: number, entries: { name: string; type: string }[] = []) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    if (url.endsWith('/access_tokens')) {
      return new Response(
        JSON.stringify({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000) }),
        { status: 201 },
      );
    }
    asked.push(url);
    return new Response(JSON.stringify(entries), { status });
  }) as typeof fetch;

  const driver = new GithubDriver(
    'gh',
    { type: 'github', app_id: '424242', private_key: process.env.TEST_GH_PRIVATE_KEY },
    undefined,
    fetchImpl,
  );
  return { driver, asked };
}

describe('asking GitHub for a root config', () => {
  it('lists the root of the default branch once, without fetching the repo', async () => {
    const { driver, asked } = driverAnswering(200, [{ name: '.speicher.yaml', type: 'file' }]);

    expect(await driver.hasRootConfig(REPO)).toBe(true);
    expect(asked).toEqual(['https://api.github.com/repos/copetence/handbook/contents?ref=main']);
  });

  it('accepts .speicher.yml as well', async () => {
    const { driver } = driverAnswering(200, [{ name: '.speicher.yml', type: 'file' }]);

    expect(await driver.hasRootConfig(REPO)).toBe(true);
  });

  it('says no when the root holds no config file', async () => {
    const { driver } = driverAnswering(200, [
      { name: 'README.md', type: 'file' },
      { name: '.speicher.yaml', type: 'dir' },
    ]);

    expect(await driver.hasRootConfig(REPO)).toBe(false);
  });

  it('cannot tell when GitHub refuses, so the caller fetches as before', async () => {
    const { driver } = driverAnswering(404);

    expect(await driver.hasRootConfig(REPO)).toBeNull();
  });
});
