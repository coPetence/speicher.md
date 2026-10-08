import { resolveRepo } from '../../src/common/inspect';
import { RoutingService } from '../../src/content-reader/routing';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { Forge, Repo } from '../../src/db/models';
import { Harness, createHarness } from '../helpers/harness';

let harness: Harness;
let routing: RoutingService;

beforeAll(async () => {
  harness = await createHarness();
  routing = new RoutingService(harness.config, getSequelize());
  const forge = await Forge.findOne({ where: { key: 'gh' } });
  for (const [namespace, slug, id] of [
    ['Ferdi', 'notes', '7001'],
    ['Copetence', 'casing', '7002'],
  ]) {
    await Repo.create({
      tenant_id: harness.tenantId,
      forge_id: forge!.id,
      forge_repo_id: id,
      namespace,
      namespace_id: id,
      slug,
      branch: 'main',
    });
  }
});

afterAll(async () => {
  await harness.close();
  await closeSequelize();
});

describe('a namespace the forge spells with capitals', () => {
  it('resolves the lowercase URL it is linked by', async () => {
    const base = routing.publicBaseFor({ namespace: 'Ferdi', slug: 'notes', forge_key: 'gh' });
    expect(base).toBe('/ferdi/notes');

    const route = await routing.resolve(harness.tenantId, ['ferdi', 'notes']);
    expect(route).toMatchObject({ namespace: 'Ferdi', repoSlug: 'notes' });
  });

  it('is still the default namespace when only the case differs', async () => {
    const base = routing.publicBaseFor({ namespace: 'Copetence', slug: 'casing', forge_key: 'gh' });
    expect(base).toBe('/casing');

    const route = await routing.resolve(harness.tenantId, ['casing']);
    expect(route).toMatchObject({ namespace: 'Copetence', repoSlug: 'casing' });
  });

  it('claims the first segment against a repository spelled the other way', async () => {
    await expect(
      routing.assertFirstSegmentFree(harness.tenantId, 'gh', 'copetence', 'casing'),
    ).rejects.toThrow(/already registered/);
  });

  it('is published by a public.repos entry in either spelling', () => {
    expect(harness.config.allowsPublic({ namespace: 'Copetence', slug: 'speicher-docs' })).toBe(
      true,
    );
  });

  it('is found by the CLI in either spelling', async () => {
    for (const asked of ['ferdi/notes', 'Ferdi/notes']) {
      const matches = await resolveRepo(harness.tenantId, asked);
      expect(matches.map((m) => `${m.namespace}/${m.slug}`)).toEqual(['Ferdi/notes']);
    }
  });
});

// No configuration lists the repository owners of a GitHub forge, so the first URL
// segment an owner claims can only be checked when its repository is registered
describe('a repository owner on the primary forge', () => {
  it('may not claim a reserved first segment', async () => {
    await expect(
      routing.assertFirstSegmentFree(harness.tenantId, 'gh', 'api', 'docs'),
    ).rejects.toThrow(/reserved/);
  });

  it('may not claim the segment of a repository of the default owner', async () => {
    await expect(
      routing.assertFirstSegmentFree(harness.tenantId, 'gh', 'Handbook', 'docs'),
    ).rejects.toThrow(/collides with repo "handbook"/);
  });

  it('keeps its segment from a repository of the default owner registered later', async () => {
    await expect(
      routing.assertFirstSegmentFree(harness.tenantId, 'gh', 'copetence', 'ferdi'),
    ).rejects.toThrow(/collides with repository owner "Ferdi"/);
  });

  it('can register a second repository under the segment it already holds', async () => {
    await expect(
      routing.assertFirstSegmentFree(harness.tenantId, 'gh', 'Ferdi', 'journal'),
    ).resolves.toBeUndefined();
  });
});
