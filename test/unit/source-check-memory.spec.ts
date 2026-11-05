import { generateKeyPairSync } from 'node:crypto';

import {
  checkSource,
  lookUpInstallation,
  rememberedInstallation,
  rememberedRows,
} from '../../src/dashboard/configurator/quick-setup/source-check';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}) as string;

const forge = { type: 'github', app_id: '1', private_key: PEM };
const known = {
  hasGroup: (name: string) => name === 'staff',
  suggestGroup: () => null,
  allowsPublic: () => false,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Repository {
  pushed_at?: string;
  files: Record<string, string>;
}

/** A GitHub that holds the given repositories and records what it was asked */
function github(repositories: Record<string, Repository>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    const path = url.pathname;
    asked.push(path);
    if (path === '/app') return json({ slug: 'speicher', owner: { login: 'acme', type: 'User' } });
    if (path === '/app/installations') {
      return json([{ id: 5, account: { login: 'acme' }, repository_selection: 'all' }]);
    }
    if (path.endsWith('/access_tokens')) {
      return json({
        token: 'ghs_token',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (path === '/installation/repositories') {
      const size = Number(url.searchParams.get('per_page'));
      const from = (Number(url.searchParams.get('page')) - 1) * size;
      return json({
        total_count: Object.keys(repositories).length,
        repositories: Object.entries(repositories)
          .slice(from, from + size)
          .map(([name, repo]) => ({
            full_name: name,
            default_branch: 'main',
            pushed_at: repo.pushed_at,
          })),
      });
    }
    const name = /^\/repos\/([^/]+\/[^/]+)\//.exec(path)?.[1] ?? '';
    if (path.includes('/git/trees/')) {
      return json({
        tree: Object.keys(repositories[name].files).map((file) => ({ path: file, type: 'blob' })),
      });
    }
    const file = path.split('/contents/')[1];
    return new Response(repositories[name].files[file]);
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

const check = (fetchImpl: typeof fetch, fresh = false) =>
  checkSource('gh', forge, known, fetchImpl, 'check', fresh);

const CONFIG = 'version: 1\naccess: [staff]\n';

describe('a check of a source that was checked before', () => {
  it('reads no repository again that has no new push, and keeps the App and the token', async () => {
    const { asked, fetchImpl } = github({
      'acme/handbook': { pushed_at: '2026-11-01T10:00:00Z', files: { '.speicher.yaml': CONFIG } },
      'acme/wiki': { pushed_at: '2026-11-01T10:00:00Z', files: {} },
    });

    const first = await check(fetchImpl);
    asked.length = 0;
    const second = await check(fetchImpl);

    expect(asked).toEqual(['/app/installations', '/installation/repositories']);
    expect(second.repositories).toEqual(first.repositories);
  });

  it('reads a repository again once it has a new push, such as a new .speicher.yaml', async () => {
    const wiki: Repository = { pushed_at: '2026-11-01T10:00:00Z', files: {} };
    const { asked, fetchImpl } = github({
      'acme/handbook': { pushed_at: '2026-11-01T10:00:00Z', files: { '.speicher.yaml': CONFIG } },
      'acme/wiki': wiki,
    });
    const first = await check(fetchImpl);
    expect(first.repositories.map((row) => row.state)).toEqual(['ready', 'unpublished']);

    wiki.pushed_at = '2026-11-01T10:05:00Z';
    wiki.files = { '.speicher.yaml': CONFIG };
    asked.length = 0;
    const second = await check(fetchImpl);

    expect(second.repositories.map((row) => row.state)).toEqual(['ready', 'ready']);
    expect(asked).toContain('/repos/acme/wiki/git/trees/main');
    expect(asked.some((path) => path.startsWith('/repos/acme/handbook/'))).toBe(false);
  });

  it('judges remembered files by the groups of now, so a new group counts at once', async () => {
    const { fetchImpl } = github({
      'acme/handbook': {
        pushed_at: '2026-11-01T10:00:00Z',
        files: { '.speicher.yaml': 'version: 1\naccess: [sales]\n' },
      },
    });
    const first = await check(fetchImpl);
    expect(first.repositories[0].state).toBe('unknown-groups');

    const second = await checkSource(
      'gh',
      forge,
      { ...known, hasGroup: (name: string) => name === 'sales' },
      fetchImpl,
    );
    expect(second.repositories[0].state).toBe('ready');
  });

  it('asks GitHub for everything when the person checks again', async () => {
    const { asked, fetchImpl } = github({
      'acme/handbook': { pushed_at: '2026-11-01T10:00:00Z', files: { '.speicher.yaml': CONFIG } },
    });
    await check(fetchImpl);
    asked.length = 0;

    await check(fetchImpl, true);

    expect(asked).toEqual([
      '/app',
      '/app/installations',
      '/app/installations/5/access_tokens',
      '/installation/repositories',
      '/repos/acme/handbook/git/trees/main',
      '/repos/acme/handbook/contents/.speicher.yaml',
    ]);
  });

  it('gives what the last check found without asking GitHub, judged by the groups of now', async () => {
    const { asked, fetchImpl } = github({
      'acme/handbook': {
        pushed_at: '2026-11-01T10:00:00Z',
        files: { '.speicher.yaml': 'version: 1\naccess: [sales]\n' },
      },
    });
    expect(rememberedRows('gh', forge, known, fetchImpl, 'setup')).toEqual([]);

    await check(fetchImpl);
    asked.length = 0;

    const rows = rememberedRows(
      'gh',
      forge,
      { ...known, hasGroup: (name: string) => name === 'sales' },
      fetchImpl,
      'setup',
    );
    expect(rows.map((row) => [row.name, row.state])).toEqual([['acme/handbook', 'ready']]);
    expect(asked).toEqual([]);
  });

  it('remembers nothing of a repository GitHub gives no push time for', async () => {
    const { asked, fetchImpl } = github({ 'acme/wiki': { files: {} } });
    await check(fetchImpl);
    asked.length = 0;

    await check(fetchImpl);

    expect(asked).toContain('/repos/acme/wiki/git/trees/main');
  });

  it('remembers the installation it found, and asks GitHub for nothing to say so', async () => {
    const { asked, fetchImpl } = github({});
    expect(rememberedInstallation(forge, fetchImpl)).toBeUndefined();

    await check(fetchImpl);
    asked.length = 0;

    expect(rememberedInstallation(forge, fetchImpl)).toEqual({
      href: 'https://github.com/settings/installations/5',
      account: 'acme',
      selection: 'all',
    });
    expect(asked).toEqual([]);
  });

  it('reads the repositories past the first page of GitHub', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 111 }, (_, index) => [
        `acme/repo-${index}`,
        { files: { '.speicher.yaml': CONFIG } },
      ]),
    );
    const { asked, fetchImpl } = github(many);

    const checked = await check(fetchImpl);

    expect(checked.repositories).toHaveLength(111);
    expect(checked.repositories[110]).toMatchObject({ name: 'acme/repo-110', state: 'ready' });
    expect(checked.repositories[110].edit_href).toContain('/edit/main/.speicher.yaml');
    expect(checked.more).toBe(false);
    expect(asked.filter((path) => path === '/installation/repositories')).toHaveLength(2);
  });

  it('looks up the installation without reading a repository, and only once', async () => {
    const { asked, fetchImpl } = github({
      'acme/handbook': { pushed_at: '2026-11-01T10:00:00Z', files: { '.speicher.yaml': CONFIG } },
    });

    await lookUpInstallation('gh', forge, fetchImpl);

    expect(rememberedInstallation(forge, fetchImpl)?.selection).toBe('all');
    expect(asked).toEqual(['/app', '/app/installations', expect.stringContaining('access_tokens')]);
    expect(asked.join(' ')).not.toContain('/repos/');

    asked.length = 0;
    await lookUpInstallation('gh', forge, fetchImpl);
    expect(asked).toEqual([]);
  });

  it('gives the check what the lookup asked GitHub for', async () => {
    const { asked, fetchImpl } = github({});
    await lookUpInstallation('gh', forge, fetchImpl);
    asked.length = 0;

    await check(fetchImpl);

    expect(asked).not.toContain('/app');
    expect(asked.join(' ')).not.toContain('access_tokens');
  });

  it('stops looking once GitHub cannot be asked', async () => {
    const fetchImpl = (async () => new Response('', { status: 502 })) as unknown as typeof fetch;

    await lookUpInstallation('gh', forge, fetchImpl);

    expect(rememberedInstallation(forge, fetchImpl)).toBeNull();
  });
});
