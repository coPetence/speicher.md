import { join } from 'node:path';

import { QueryTypes } from 'sequelize';

import { getSequelize } from '../../src/db/sequelize';
import { closeSequelize } from '../../src/db/sequelize';
import { FIXTURE_ROOT, FIXTURE_SHA, Harness, createHarness } from '../helpers/harness';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
  await closeSequelize();
});

async function documentRow(repoId: string, slugPath: string) {
  const rows = await getSequelize().query<{
    slug_path: string;
    title: string;
    effective_principals: string[];
    indexable: boolean;
    is_index: boolean;
    sort_order: number | null;
    html: string;
    plain: string;
    markdown: string;
    cover_path: string | null;
  }>(
    `SELECT slug_path, title, effective_principals, indexable, is_index, sort_order,
            html, plain, markdown, cover_path
       FROM documents WHERE repo_id = :repoId AND slug_path = :slugPath`,
    { type: QueryTypes.SELECT, replacements: { repoId, slugPath } },
  );
  return rows[0] ?? null;
}

describe('ingest materialises the cascade onto every row', () => {
  it('grants the repo root set to root-level pages', async () => {
    const intro = await documentRow(harness.repos.handbook, 'introduction');
    expect(intro).not.toBeNull();
    expect(intro!.effective_principals.sort()).toEqual([
      'group:client-northwind',
      'group:commercial',
      'group:engineering',
      'user:entra:dave-oid',
    ]);
  });

  it('intersects at level two, dropping every principal the folder did not name', async () => {
    const pricing = await documentRow(harness.repos.handbook, 'commercial/pricing');
    expect(pricing!.effective_principals).toEqual(['group:commercial']);
  });

  it('resolves a third level that intersects to nobody', async () => {
    const contracts = await documentRow(harness.repos.handbook, 'commercial/legal/contracts');
    expect(contracts!.effective_principals).toEqual([]);
  });

  it('records the whole chain in config_source, for explain', async () => {
    const rows = await getSequelize().query<{ config_source: { chain: { source: string }[] } }>(
      `SELECT config_source FROM documents WHERE repo_id = :repoId AND slug_path = :slugPath`,
      {
        type: QueryTypes.SELECT,
        replacements: { repoId: harness.repos.handbook, slugPath: 'commercial/legal/contracts' },
      },
    );
    expect(rows[0].config_source.chain.map((l) => l.source)).toEqual([
      '<instance>',
      '.speicher.yaml',
      'docs/commercial/.speicher.yaml',
      'docs/commercial/legal/.speicher.yaml',
    ]);
  });
});

describe('ordering, titles and index pages', () => {
  it('strips the numeric prefix from the slug so renumbering does not move URLs', async () => {
    expect(await documentRow(harness.repos.handbook, 'introduction')).not.toBeNull();
    expect(await documentRow(harness.repos.handbook, '01-introduction')).toBeNull();
  });

  it('keeps the numeric prefix as the sort order', async () => {
    expect((await documentRow(harness.repos.handbook, 'introduction'))!.sort_order).toBe(1);
    expect((await documentRow(harness.repos.handbook, 'setup'))!.sort_order).toBe(2);
    expect((await documentRow(harness.repos.handbook, 'troubleshooting'))!.sort_order).toBeNull();
  });

  it('prefers frontmatter title, then the H1', async () => {
    expect((await documentRow(harness.repos.handbook, 'setup'))!.title).toBe('Setting up');
    expect((await documentRow(harness.repos.handbook, 'introduction'))!.title).toBe('Introduction');
  });

  it('gives index.md the folder path and no URL of its own', async () => {
    const root = await documentRow(harness.repos.handbook, '');
    expect(root).not.toBeNull();
    expect(root!.is_index).toBe(true);
    expect(await documentRow(harness.repos.handbook, 'index')).toBeNull();
    expect(await documentRow(harness.repos.handbook, 'commercial/index')).toBeNull();
  });

  it('excludes README.md by default', async () => {
    expect(await documentRow(harness.repos.handbook, 'readme')).toBeNull();
  });
});

describe('retrieval', () => {
  it('honours indexable false from a folder config', async () => {
    expect((await documentRow(harness.repos.handbook, 'commercial/pricing'))!.indexable).toBe(
      false,
    );
  });

  it('honours indexable false from frontmatter', async () => {
    expect((await documentRow(harness.repos.handbook, 'troubleshooting'))!.indexable).toBe(false);
  });

  it('leaves everything else indexable', async () => {
    expect((await documentRow(harness.repos.handbook, 'introduction'))!.indexable).toBe(true);
  });
});

describe('rendering is sanitised at ingest, so no render path can undo it', () => {
  it('drops script tags entirely', async () => {
    const page = await documentRow(harness.repos.handbook, 'troubleshooting');
    expect(page!.html).not.toContain('<script');
    expect(page!.html).not.toContain('alert(');
  });

  it('strips javascript: URLs from links', async () => {
    const page = await documentRow(harness.repos.handbook, 'troubleshooting');
    expect(page!.html).not.toContain('javascript:');
  });

  it('never emits the frontmatter block as content', async () => {
    const page = await documentRow(harness.repos.handbook, 'setup');
    expect(page!.html).not.toContain('redirect_from');
    expect(page!.plain).not.toContain('redirect_from');
    expect(page!.markdown).not.toContain('redirect_from');
  });

  it('rewrites internal links to a repo-relative sentinel, not a baked-in URL', async () => {
    const root = await documentRow(harness.repos.handbook, '');
    expect(root!.html).toContain('/~repo~/introduction');
    expect(root!.html).not.toContain('/handbook/introduction');

    const pricing = await documentRow(harness.repos.handbook, 'commercial/pricing');
    expect(pricing!.html).toContain('/~repo~/introduction');
    expect(pricing!.html).toContain('/~repo~/commercial/images/chart.jpg');
  });

  it('stores code already tokenised, and still indexes it as code', async () => {
    const page = await documentRow(harness.repos.handbook, 'introduction');
    expect(page!.html).toContain('class="language-yaml"');
    expect(page!.html).toContain('spr-tok-');
    expect(page!.plain).toContain('groups: [commercial]');
    expect(page!.plain).not.toContain('spr-tok-');
  });

  it('marks a broken internal link rather than failing the sync', async () => {
    const page = await documentRow(harness.repos.handbook, 'setup');
    expect(page!.html).toContain('data-broken="true"');
  });
});

describe('a link to a page fewer people can read is reported to the author', () => {
  async function findings(repoId: string) {
    const rows = await getSequelize().query<{
      findings: { code: string; source: string; message: string; adminMessage?: string }[];
    }>(`SELECT findings FROM sync_runs WHERE repo_id = :repoId ORDER BY started_at DESC LIMIT 1`, {
      type: QueryTypes.SELECT,
      replacements: { repoId },
    });
    return rows[0].findings;
  }

  it('warns once per narrower target', async () => {
    const narrower = (await findings(harness.repos.handbook)).filter(
      (f) => f.code === 'link-narrower-target',
    );
    expect(narrower.map((f) => f.source)).toEqual([
      'docs/03-where-things-live.md',
      'docs/03-where-things-live.md',
      'docs/03-where-things-live.md',
      'docs/03-where-things-live.md',
    ]);
  });

  it('warns rather than rejects, because the link is legitimate content', async () => {
    const narrower = (await findings(harness.repos.handbook)).filter(
      (f) => f.code === 'link-narrower-target',
    );
    expect(narrower.every((f) => (f as unknown as { severity: string }).severity === 'warn')).toBe(
      true,
    );
  });

  it('tells the author a count and the admin which principals lose access', async () => {
    const pricing = (await findings(harness.repos.handbook)).find(
      (f) => f.code === 'link-narrower-target' && f.message.includes('commercial/pricing.md'),
    );
    expect(pricing).toBeDefined();
    expect(pricing!.message).toContain('will 404 for 3');
    expect(pricing!.message).not.toContain('group:engineering');
    expect(pricing!.adminMessage).toContain('group:engineering');
    expect(pricing!.adminMessage).toContain('user:entra:dave-oid');
  });

  it('does not warn about a link whose target is readable by more people', async () => {
    const narrower = (await findings(harness.repos.handbook)).filter(
      (f) => f.code === 'link-narrower-target' && f.source === 'docs/commercial/pricing.md',
    );
    expect(narrower).toEqual([]);
  });

  it('does not warn about a link whose target has the same audience', async () => {
    const narrower = (await findings(harness.repos.handbook)).filter(
      (f) => f.code === 'link-narrower-target' && f.message.includes('02-setup.md'),
    );
    expect(narrower).toEqual([]);
  });

  it('does not fail the sync over it', async () => {
    const rows = await getSequelize().query<{ last_status: string }>(
      `SELECT last_status FROM repos WHERE id = :repoId`,
      { type: QueryTypes.SELECT, replacements: { repoId: harness.repos.handbook } },
    );
    expect(rows[0].last_status).toBe('ok');
  });
});

describe('icons', () => {
  async function iconOf(table: 'documents' | 'folders', slugPath: string) {
    const rows = await getSequelize().query<{ icon: string | null }>(
      `SELECT icon FROM ${table} WHERE repo_id = :repoId AND slug_path = :slugPath`,
      { type: QueryTypes.SELECT, replacements: { repoId: harness.repos.handbook, slugPath } },
    );
    return rows[0]?.icon ?? null;
  }

  it('stores a valid Lucide name from frontmatter', async () => {
    expect(await iconOf('documents', 'introduction')).toBe('sparkles');
    expect(await iconOf('documents', 'setup')).toBe('wrench');
    expect(await iconOf('documents', 'troubleshooting')).toBe('circle-alert');
  });

  it('leaves a page without an icon null rather than inventing one', async () => {
    expect(await iconOf('documents', 'northwind/handover')).toBeNull();
  });

  it('gives a folder the icon from its own index.md, as it does the title', async () => {
    expect(await iconOf('folders', '')).toBe('book-open');
    expect(await iconOf('folders', 'commercial')).toBe('banknote');
    expect(await iconOf('folders', 'northwind')).toBeNull();
  });

  it('drops an unknown name and warns with the near match', async () => {
    const rows = await getSequelize().query<{
      findings: {
        code: string;
        source: string;
        message: string;
        suggestion?: string;
        severity: string;
      }[];
    }>(`SELECT findings FROM sync_runs WHERE repo_id = :repoId ORDER BY started_at DESC LIMIT 1`, {
      type: QueryTypes.SELECT,
      replacements: { repoId: harness.repos.handbook },
    });
    const finding = rows[0].findings.find((f) => f.code === 'unknown-icon');
    expect(finding).toBeDefined();
    expect(finding!.source).toBe('docs/commercial/pricing.md');
    expect(finding!.suggestion).toBe('receipt-euro');
    expect(finding!.severity).toBe('warn');
    expect(await iconOf('documents', 'commercial/pricing')).toBeNull();
  });

  it('does not fail the sync over an unknown icon', async () => {
    const rows = await getSequelize().query<{ last_status: string }>(
      `SELECT last_status FROM repos WHERE id = :repoId`,
      { type: QueryTypes.SELECT, replacements: { repoId: harness.repos.handbook } },
    );
    expect(rows[0].last_status).toBe('ok');
  });
});

describe('assets', () => {
  it('ingests an image referenced from content even though sync.include is **/*.md', async () => {
    const rows = await getSequelize().query<{
      slug_path: string;
      mime: string;
      effective_principals: string[];
    }>(
      `SELECT slug_path, mime, effective_principals FROM assets WHERE repo_id = :repoId ORDER BY slug_path`,
      { type: QueryTypes.SELECT, replacements: { repoId: harness.repos.handbook } },
    );
    const paths = rows.map((r) => r.slug_path);
    expect(paths).toContain('commercial/images/chart.jpg');
  });

  it('gives an asset the access of the directory it belongs to', async () => {
    const rows = await getSequelize().query<{ effective_principals: string[] }>(
      `SELECT effective_principals FROM assets WHERE repo_id = :repoId AND slug_path = :slugPath`,
      {
        type: QueryTypes.SELECT,
        replacements: { repoId: harness.repos.handbook, slugPath: 'commercial/images/chart.jpg' },
      },
    );
    expect(rows[0].effective_principals).toEqual(['group:commercial']);
  });

  it('ingests the repo cover, which lives outside ingest_root', async () => {
    const rows = await getSequelize().query<{ slug_path: string; effective_principals: string[] }>(
      `SELECT slug_path, effective_principals FROM assets WHERE repo_id = :repoId AND slug_path LIKE '_repo/%'`,
      { type: QueryTypes.SELECT, replacements: { repoId: harness.repos.handbook } },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].slug_path).toBe('_repo/cover.jpg');
    expect(rows[0].effective_principals.sort()).toEqual([
      'group:client-northwind',
      'group:commercial',
      'group:engineering',
      'user:entra:dave-oid',
    ]);
  });

  it('stores the bytes in the blob store keyed by content hash', async () => {
    const rows = await getSequelize().query<{ content_hash: string }>(
      `SELECT content_hash FROM assets WHERE repo_id = :repoId AND slug_path = :slugPath`,
      {
        type: QueryTypes.SELECT,
        replacements: { repoId: harness.repos.handbook, slugPath: 'commercial/images/chart.jpg' },
      },
    );
    await expect(harness.blobs.exists(harness.repos.handbook, rows[0].content_hash)).resolves.toBe(
      true,
    );
  });
});

describe('redirects', () => {
  it('stores redirect_from repo-relative, so a rename cannot invalidate the row', async () => {
    const rows = await getSequelize().query<{ from_path: string; to_path: string; reason: string }>(
      `SELECT from_path, to_path, reason FROM redirects WHERE repo_id = :repoId`,
      { type: QueryTypes.SELECT, replacements: { repoId: harness.repos.handbook } },
    );
    expect(rows).toEqual([
      { from_path: 'getting-started', to_path: 'setup', reason: 'redirect_from' },
    ]);
  });
});

describe('repo state after a run', () => {
  it('stamps the SHA, the ingest root, the title and the maintainers', async () => {
    const rows = await getSequelize().query<{
      last_sha: string;
      last_status: string;
      ingest_root: string;
      display_title: string;
      maintainer_principals: string[];
      next_grant_review_at: Date;
    }>(
      `SELECT last_sha, last_status, ingest_root, display_title, maintainer_principals,
              next_grant_review_at
         FROM repos WHERE id = :repoId`,
      { type: QueryTypes.SELECT, replacements: { repoId: harness.repos.handbook } },
    );
    const repo = rows[0];
    expect(repo.last_status).toBe('ok');
    expect(repo.ingest_root).toBe('docs');
    expect(repo.display_title).toBe('coPetence Handbook');
    expect(repo.maintainer_principals).toEqual(['group:engineering']);
    expect(repo.next_grant_review_at).toBeInstanceOf(Date);
  });
});

describe('the instance decides which repositories may grant `public`', () => {
  it('materialises `group:public` where both halves agree', async () => {
    const row = await documentRow(harness.repos.speicherDocs, 'getting-started');
    expect(row?.effective_principals).toEqual(['group:engineering', 'group:public']);
  });

  it('keeps the narrowed subtree out of it', async () => {
    const row = await documentRow(harness.repos.speicherDocs, 'internal/roadmap');
    expect(row?.effective_principals).toEqual(['group:engineering']);
  });

  it('never lets `public` into maintainer_principals', async () => {
    const rows = await getSequelize().query<{ maintainer_principals: string[] }>(
      `SELECT maintainer_principals FROM repos WHERE id = :repoId`,
      { type: QueryTypes.SELECT, replacements: { repoId: harness.repos.speicherDocs } },
    );
    expect(rows[0].maintainer_principals).toEqual(['group:engineering']);
  });

  it('rejects the same repository content under a repository it has not published', async () => {
    const result = await harness.ingest.syncRepo(harness.repos.handbook, {
      workingTree: join(FIXTURE_ROOT, 'repos', 'speicher-docs'),
      sha: FIXTURE_SHA,
      trigger: 'manual',
      now: new Date('2026-08-21T12:00:00Z'),
    });
    expect(result.status).toBe('failed');
    expect(result.findings.map((f) => f.code)).toContain('public-not-enabled');

    const row = await documentRow(harness.repos.handbook, 'introduction');
    expect(row?.effective_principals).toContain('group:engineering');
    expect(row?.effective_principals).not.toContain('group:public');
  });
});
