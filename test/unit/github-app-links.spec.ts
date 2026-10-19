import { generateKeyPairSync } from 'node:crypto';

import { stringify } from 'yaml';

import { ConfigService } from '../../src/config/config.service';
import {
  GithubAppLinksItem,
  cardItems,
  sectionOf,
} from '../../src/dashboard/configurator/config-form/fields';
import { loadDocument } from '../../src/dashboard/configurator/config-form/document';
import { SectionChecks } from '../../src/dashboard/configurator/config-page/checks';
import type { ConfigSectionPayload } from '../../src/dashboard/configurator/config-page/payloads';
import { githubAppLinks, lookupGithubApp } from '../../src/github/app-links';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs1',
  format: 'pem',
}) as string;

const ACME_APP = { slug: 'speicher-md', owner: { login: 'acme', type: 'Organization' } };

/** A fetch that answers `GET /app` with `body`, and records what it was asked */
function fakeGithub(body: unknown = ACME_APP, status = 200) {
  const asked: { url: string; authorization: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    asked.push({
      url,
      authorization: (init?.headers as Record<string, string>).Authorization,
    });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

/** The page of a section, as the configurator sends it, built from `config` */
function pageOf(
  config: object,
  sectionId: string,
): { payload: ConfigSectionPayload; yaml: string } {
  const yaml = stringify(config);
  const section = sectionOf(loadDocument(yaml), sectionId)!;
  return { payload: { section } as ConfigSectionPayload, yaml };
}

/** The links item on a page */
function linksOn(payload: ConfigSectionPayload): GithubAppLinksItem | undefined {
  return cardItems([payload.section!]).find(
    (item): item is GithubAppLinksItem => item.kind === 'github-app-links',
  );
}

describe('the links to a GitHub App', () => {
  it('lead to the settings of an App owned by an organization', () => {
    expect(
      githubAppLinks('https://github.com', 'speicher-md', {
        accountName: 'acme',
        isOrganization: true,
      }),
    ).toEqual({
      settingsUrl: 'https://github.com/organizations/acme/settings/apps/speicher-md',
      installUrl: 'https://github.com/apps/speicher-md/installations/new',
    });
  });

  it('lead to the settings of an App owned by a person', () => {
    expect(
      githubAppLinks('https://github.com', 'speicher-md', {
        accountName: 'ada',
        isOrganization: false,
      }).settingsUrl,
    ).toBe('https://github.com/settings/apps/speicher-md');
  });

  it('use the paths of a GitHub Enterprise Server', () => {
    expect(
      githubAppLinks('https://ghe.example.test', 'speicher-md', {
        accountName: 'acme',
        isOrganization: true,
      }).installUrl,
    ).toBe('https://ghe.example.test/github-apps/speicher-md/installations/new');
  });
});

describe('looking a GitHub App up', () => {
  it('asks GET /app, signed as the App', async () => {
    const { asked, fetchImpl } = fakeGithub();

    expect(await lookupGithubApp('https://api.github.com', '42', PEM, fetchImpl)).toEqual({
      slug: 'speicher-md',
      owner: { accountName: 'acme', isOrganization: true },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0].url).toBe('https://api.github.com/app');
    expect(asked[0].authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('fails when GitHub refuses the App', async () => {
    const { fetchImpl } = fakeGithub({ message: 'Bad credentials' }, 401);

    await expect(lookupGithubApp('https://api.github.com', '42', PEM, fetchImpl)).rejects.toThrow(
      /401/,
    );
  });
});

describe('the links on the card of a content source', () => {
  const SOURCE = { forges: { gh: { type: 'github', app_id: '42', private_key: PEM } } };

  it('are looked up from the App id and the private key', async () => {
    const { asked, fetchImpl } = fakeGithub();
    const checks = new SectionChecks(
      {} as ConfigService,
      null,
      null,
      undefined,
      undefined,
      fetchImpl,
    );
    const { payload, yaml } = pageOf(SOURCE, 'sources/gh');

    await checks.stampGithubAppLinks(payload, yaml);

    expect(linksOn(payload)).toMatchObject({
      settingsUrl: 'https://github.com/organizations/acme/settings/apps/speicher-md',
      installUrl: 'https://github.com/apps/speicher-md/installations/new',
    });
    expect(asked).toHaveLength(1);
  });

  it('are asked for once, then kept', async () => {
    const { asked, fetchImpl } = fakeGithub();
    const checks = new SectionChecks(
      {} as ConfigService,
      null,
      null,
      undefined,
      undefined,
      fetchImpl,
    );

    for (let view = 0; view < 2; view++) {
      const { payload, yaml } = pageOf(SOURCE, 'sources/gh');
      await checks.stampGithubAppLinks(payload, yaml);
      expect(linksOn(payload)?.settingsUrl).not.toBe('');
    }
    expect(asked).toHaveLength(1);
  });

  it('are left out when GitHub cannot be asked', async () => {
    const { fetchImpl } = fakeGithub({ message: 'Bad credentials' }, 401);
    const checks = new SectionChecks(
      {} as ConfigService,
      null,
      null,
      undefined,
      undefined,
      fetchImpl,
    );
    const { payload, yaml } = pageOf(SOURCE, 'sources/gh');

    await checks.stampGithubAppLinks(payload, yaml);

    expect(linksOn(payload)).toMatchObject({ settingsUrl: '', installUrl: '' });
  });

  it('are not offered before the source has an App', () => {
    const { payload } = pageOf({ forges: { gh: { type: 'github' } } }, 'sources/gh');

    expect(linksOn(payload)).toBeUndefined();
  });
});

describe('the links on the card of a GitHub directory', () => {
  it("are looked up on the provider's GitHub Enterprise Server", async () => {
    const { asked, fetchImpl } = fakeGithub();
    const checks = new SectionChecks(
      {} as ConfigService,
      null,
      null,
      undefined,
      undefined,
      fetchImpl,
    );
    const { payload, yaml } = pageOf(
      {
        auth: {
          providers: {
            hub: {
              type: 'github',
              client_id: 'Iv1.abc',
              base_url: 'https://ghe.example.test',
              directory: { type: 'github', app_id: '7', private_key: PEM },
            },
          },
        },
      },
      'identity/hub',
    );

    await checks.stampGithubAppLinks(payload, yaml);

    expect(asked[0].url).toBe('https://ghe.example.test/api/v3/app');
    expect(linksOn(payload)?.installUrl).toBe(
      'https://ghe.example.test/github-apps/speicher-md/installations/new',
    );
  });
});

describe('the links on the card of a GitHub identity provider', () => {
  const provider = (clientId: string) => ({
    auth: {
      providers: {
        hub: {
          type: 'github',
          client_id: clientId,
          app: {
            client_id: 'Iv1.abc',
            slug: 'speicher-md',
            owner_account: 'ada',
            owner_is_organization: false,
          },
        },
      },
    },
  });

  it('are built from the App Speicher created, without asking GitHub', () => {
    const { payload } = pageOf(provider('Iv1.abc'), 'identity/hub');

    expect(linksOn(payload)).toMatchObject({
      lookup: [],
      settingsUrl: 'https://github.com/settings/apps/speicher-md',
      installUrl: 'https://github.com/apps/speicher-md/installations/new',
    });
  });

  it('are left out once the client id names another App', () => {
    const { payload } = pageOf(provider('Iv1.other'), 'identity/hub');

    expect(linksOn(payload)).toBeUndefined();
  });
});
