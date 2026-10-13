import type { Sequelize } from 'sequelize';

import type { ConfigService } from '../../src/config/config.service';
import { RoutingService } from '../../src/content-reader/routing';

// `gh` is primary and leaves out `copetence`; `onprem` is not primary and leaves out `internal`
const OWNERS: Record<string, string> = { gh: 'copetence', onprem: 'internal' };
const REPOS = [
  { id: 'r1', namespace: 'internal', slug: 'runbooks', forge_key: 'onprem' },
  { id: 'r2', namespace: 'partners', slug: 'docs', forge_key: 'onprem' },
  { id: 'r3', namespace: 'copetence', slug: 'handbook', forge_key: 'gh' },
];

const config = {
  primaryForgeId: 'gh',
  forge: (id: string) => (id in OWNERS ? {} : undefined),
  defaultRepositoryOwnerFor: (id: string) => OWNERS[id],
} as unknown as ConfigService;

// Answers the repository lookup by forge and slug, and finds no renamed repository
const sequelize = {
  query: async (sql: string, options: { replacements: Record<string, string> }) => {
    if (sql.includes('repo_slug_history')) return [];
    const { forgeKey, slug } = options.replacements;
    return REPOS.filter((repo) => repo.forge_key === forgeKey && repo.slug === slug).map(
      (repo) => ({ ...repo, forge_is_primary: forgeKey === 'gh' }),
    );
  },
} as unknown as Sequelize;

const routing = new RoutingService(config, sequelize);

describe('the default repository owner of a forge that is not primary', () => {
  it('is left out of the URL, after the id of the forge', () => {
    const base = routing.publicBaseFor({
      namespace: 'internal',
      slug: 'runbooks',
      forge_key: 'onprem',
    });
    expect(base).toBe('/onprem/runbooks');
  });

  it('resolves the URL it is left out of, at the root and below it', async () => {
    expect(await routing.resolve('t', ['onprem', 'runbooks', 'guide', 'setup'])).toMatchObject({
      repoId: 'r1',
      slugPath: 'guide/setup',
    });
    expect(await routing.resolve('t', ['onprem', 'runbooks'])).toMatchObject({
      repoId: 'r1',
      slugPath: '',
    });
  });

  it('still resolves a repository of another owner by its owner', async () => {
    expect(await routing.resolve('t', ['onprem', 'partners', 'docs', 'intro'])).toMatchObject({
      repoId: 'r2',
      slugPath: 'intro',
    });
  });

  it('leaves the primary forge as it was', async () => {
    expect(await routing.resolve('t', ['handbook', 'intro'])).toMatchObject({
      repoId: 'r3',
      slugPath: 'intro',
    });
  });
});
