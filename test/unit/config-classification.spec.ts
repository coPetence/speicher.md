import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONFIG_KEY_EFFECTS,
  HOT_RELOAD_AVAILABLE,
  compareConfigs,
  effectFor,
} from '../../src/config/classification';
import { LoadedInstanceConfig, loadInstanceConfigFromFile } from '../../src/config/parser';
import { computeResolutionHash } from '../../src/config/resolution-hash';
import { InstanceConfig } from '../../src/config/types';

const SCHEMA = JSON.parse(
  readFileSync(join(__dirname, '../../src/config/schema/instance.schema.json'), 'utf8'),
) as { properties: Record<string, unknown> };

const BASE = loadInstanceConfigFromFile(process.env.SPEICHER_CONFIG as string);

const SAMPLE_EDIT: Record<string, (config: InstanceConfig) => void> = {
  version: (c) => {
    (c as { version: number }).version = 2;
  },
  mail: (c) => {
    c.mail = { host: 'smtp.example.test', port: 587, from: 'docs@example.test' } as never;
  },
  assets: (c) => {
    c.assets = { driver: 'filesystem', path: './var/elsewhere' } as never;
  },
  theme: (c) => {
    c.theme = { template: 'slate' };
  },
  attribution: (c) => {
    c.attribution = false;
  },
  brand: (c) => {
    c.brand = { name: 'Acme Engineering Docs' };
  },
  graph: (c) => {
    c.graph = { enabled: false };
  },
  analytics: (c) => {
    c.analytics = { enabled: true, granularity: 'hour' };
  },
  notify: (c) => {
    c.notify = { stale_after: '9h' } as never;
  },
  embedding: (c) => {
    c.embedding = { model: 'text-embedding-3-small' } as never;
  },
  auth: (c) => {
    (c.auth!.providers.entra as { subject_claim?: string }).subject_claim = 'sub';
  },
  admins: (c) => {
    c.admins = { groups: ['platform-ops', 'engineering'] };
  },
  groups: (c) => {
    c.groups = { ...c.groups, 'client-acme': [{ provider: 'entra', id: 'grp-acme' }] };
  },
  public: (c) => {
    c.public = { repos: ['copetence/speicher-docs', 'copetence/handbook'] };
  },
  forges: (c) => {
    c.forges!.gh.default_repository_owner = 'northwind-engineering';
  },
  defaults: (c) => {
    c.defaults = { sync: { include: ['**/*.mdx'] }, retrieval: { indexable: false } };
  },
  autolink: (c) => {
    c.autolink = { exclude_domains: ['speicher.md'] };
  },
};

function edited(key: string): InstanceConfig {
  const clone = JSON.parse(JSON.stringify(BASE.raw)) as InstanceConfig;
  SAMPLE_EDIT[key](clone);
  return clone;
}

function loadedFrom(raw: InstanceConfig): LoadedInstanceConfig {
  return { ...BASE, raw, resolutionHash: computeResolutionHash(raw, BASE.primaryForgeId) };
}

describe('the per-key classification', () => {
  it('covers every top-level key the schema has', () => {
    const inSchema = Object.keys(SCHEMA.properties).sort();
    expect(Object.keys(CONFIG_KEY_EFFECTS).sort()).toEqual(inSchema);
  });

  it('has a sample edit for every key, or the agreement test below proves nothing', () => {
    expect(Object.keys(SAMPLE_EDIT).sort()).toEqual(Object.keys(CONFIG_KEY_EFFECTS).sort());
  });

  it('falls back conservatively for a key it has never heard of', () => {
    const unknown = effectFor('something-the-schema-grew-later');
    expect(unknown.affectsResolution).toBe(true);
    expect(unknown.requiresRestart).toBe(true);
  });

  describe.each(Object.keys(CONFIG_KEY_EFFECTS))('%s', (key) => {
    it('claims about the resolution hash what the hash actually does', () => {
      const after = computeResolutionHash(edited(key), BASE.primaryForgeId);
      expect(after !== BASE.resolutionHash).toBe(CONFIG_KEY_EFFECTS[key].affectsResolution);
    });
  });
});

describe('the group half of the hash', () => {
  type WithGroups = InstanceConfig & { groups: NonNullable<InstanceConfig['groups']> };

  const hashOf = (edit: (config: WithGroups) => void): string => {
    const clone = JSON.parse(JSON.stringify(BASE.raw)) as WithGroups;
    edit(clone);
    return computeResolutionHash(clone, BASE.primaryForgeId);
  };

  it('does not move when a group gains a source', () => {
    expect(
      hashOf((c) => {
        c.groups.engineering = [...c.groups.engineering, { provider: 'entra', id: 'grp-eng-2' }];
      }),
    ).toBe(BASE.resolutionHash);
  });

  it('does not move when a source is edited or removed', () => {
    expect(
      hashOf((c) => (c.groups.engineering = [{ provider: 'entra', id: 'somebody-else' }])),
    ).toBe(BASE.resolutionHash);
    expect(hashOf((c) => (c.groups.engineering = []))).toBe(BASE.resolutionHash);
  });

  it('moves when a group is defined', () => {
    expect(
      hashOf((c) => (c.groups['client-acme'] = [{ provider: 'entra', id: 'grp-acme' }])),
    ).not.toBe(BASE.resolutionHash);
  });

  it('moves when a group is removed', () => {
    expect(hashOf((c) => delete c.groups.commercial)).not.toBe(BASE.resolutionHash);
  });

  it('does not move when the map is merely reordered', () => {
    expect(
      hashOf((c) => {
        c.groups = Object.fromEntries(Object.entries(c.groups).reverse()) as typeof c.groups;
      }),
    ).toBe(BASE.resolutionHash);
  });
});

describe('the verdict', () => {
  it('finds nothing to say when nothing differs', () => {
    const verdict = compareConfigs(BASE, BASE);
    expect(verdict.changed).toEqual([]);
    expect(verdict.effect).toBe('none');
    expect(verdict.rebuild).toBe(false);
  });

  it('does not call a reordered document a change', () => {
    const reordered = Object.fromEntries(
      Object.entries(BASE.raw as unknown as Record<string, unknown>).reverse(),
    ) as unknown as InstanceConfig;
    expect(compareConfigs(BASE, loadedFrom(reordered)).changed).toEqual([]);
  });

  it('names the changed key, and only that key', () => {
    const verdict = compareConfigs(BASE, loadedFrom(edited('theme')));
    expect(verdict.changed.map((c) => c.key)).toEqual(['theme']);
  });

  it('says a rebuild is coming when the resolution hash moves', () => {
    const verdict = compareConfigs(BASE, loadedFrom(edited('groups')));
    expect(verdict.rebuild).toBe(true);
    expect(verdict.effect).toBe('rebuild');
  });

  it('says no rebuild when the key is outside the hash', () => {
    const verdict = compareConfigs(BASE, loadedFrom(edited('theme')));
    expect(verdict.rebuild).toBe(false);
    expect(verdict.changed[0].affectsResolution).toBe(false);
  });

  it('takes the rebuild answer from the hash rather than from the key list', () => {
    const proposed = loadedFrom(edited('theme'));
    const pretendResolutionChanged = { ...proposed, resolutionHash: 'a-different-hash' };
    expect(compareConfigs(BASE, pretendResolutionChanged).rebuild).toBe(true);
  });

  it('says a changed provider applies per request, and rebuilds', () => {
    const verdict = compareConfigs(BASE, loadedFrom(edited('auth')));
    expect(verdict.changed.map((c) => c.key)).toEqual(['auth']);
    expect(verdict.changed[0].requiresRestart).toBe(false);
    expect(verdict.rebuild).toBe(true);
    expect(verdict.effect).toBe('rebuild');
  });

  it('says a repointed mail relay applies per request, and rebuilds nothing', () => {
    const verdict = compareConfigs(BASE, loadedFrom(edited('mail')));
    expect(verdict.changed.map((c) => c.key)).toEqual(['mail']);
    expect(verdict.changed[0].requiresRestart).toBe(false);
    expect(verdict.rebuild).toBe(false);
    expect(verdict.effect).toBe(HOT_RELOAD_AVAILABLE ? 'hot' : 'restart');
  });

  it('says a changed forge applies per request, and rebuilds', () => {
    const verdict = compareConfigs(BASE, loadedFrom(edited('forges')));
    expect(verdict.changed.map((c) => c.key)).toEqual(['forges']);
    expect(verdict.changed[0].requiresRestart).toBe(false);
    expect(verdict.rebuild).toBe(true);
    expect(verdict.effect).toBe('rebuild');
  });

  it('does not promise that a per-request key applies without a restart', () => {
    const verdict = compareConfigs(BASE, loadedFrom(edited('theme')));
    expect(verdict.changed[0].requiresRestart).toBe(false);
    expect(verdict.hotReloadAvailable).toBe(HOT_RELOAD_AVAILABLE);
    expect(verdict.effect).toBe(HOT_RELOAD_AVAILABLE ? 'hot' : 'restart');
  });
});
