import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { QueryTypes } from 'sequelize';

import { Forge, Repo } from '../../src/db/models';
import { closeSequelize, getSequelize } from '../../src/db/sequelize';
import { toVectorLiteral } from '../../src/db/vector';
import { FIXTURE_SHA, Harness, createHarness } from '../helpers/harness';

let harness: Harness;
let workingTree: string;
let repoId: string;

const PAGES = {
  'docs/01-alpha.md': body('Alpha', 'alpha'),
  'docs/02-beta.md': body('Beta', 'beta'),
};

function body(title: string, word: string): string {
  const paragraph = (n: number) => `Paragraph ${n} of ${title}. ${`${word} `.repeat(120).trim()}`;
  return [
    '---',
    `title: ${title}`,
    '---',
    '',
    `# ${title}`,
    '',
    ...[1, 2, 3, 4, 5, 6].flatMap((n) => [paragraph(n), '']),
  ].join('\n');
}

function write(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(workingTree, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

async function sync(): Promise<{ chunks_written: number }> {
  const result = await harness.ingest.syncRepo(repoId, {
    workingTree,
    sha: FIXTURE_SHA,
    trigger: 'manual',
    now: new Date('2026-08-21T12:00:00Z'),
  });
  if (result.status !== 'ok') throw new Error(result.authorSummary ?? 'sync failed');
  return result.stats;
}

interface ChunkRow {
  id: string;
  slug_path: string;
  ord: number;
  text: string;
  content_hash: string;
  embedding: string | null;
}

async function chunks(slugPath?: string): Promise<ChunkRow[]> {
  return getSequelize().query<ChunkRow>(
    `SELECT id, slug_path, ord, text, content_hash, embedding::text AS embedding
       FROM chunks
      WHERE repo_id = :repoId ${slugPath ? 'AND slug_path = :slugPath' : ''}
      ORDER BY slug_path, ord`,
    { type: QueryTypes.SELECT, replacements: { repoId, slugPath } },
  );
}

async function embedEverything(): Promise<void> {
  await getSequelize().query(
    `UPDATE chunks SET embedding = :vector::vector, embedding_model = 'test', embedding_dim = 3
      WHERE repo_id = :repoId`,
    { type: QueryTypes.UPDATE, replacements: { repoId, vector: toVectorLiteral([1, 2, 3]) } },
  );
}

beforeAll(async () => {
  harness = await createHarness();
  const forge = await Forge.findOne({ where: { tenant_id: harness.tenantId } });
  const repo = await Repo.create({
    tenant_id: harness.tenantId,
    forge_id: (forge as Forge).id,
    forge_repo_id: '41775320',
    namespace: 'copetence',
    namespace_id: '9001',
    slug: 'chunked',
    branch: 'main',
  });
  repoId = repo.id;

  workingTree = mkdtempSync(join(tmpdir(), 'speicher-chunks-'));
  write({
    '.speicher.yaml': [
      'version: 1',
      'access:',
      '  groups: [engineering]',
      'ingest_root: docs',
      '',
    ].join('\n'),
    ...PAGES,
  });
});

afterAll(async () => {
  if (workingTree) rmSync(workingTree, { recursive: true, force: true });
  await harness?.close();
  await closeSequelize();
});

describe('chunks at ingest', () => {
  it('writes chunks for every page, in the same transaction as the pages', async () => {
    const stats = await sync();
    const rows = await chunks();

    expect(stats.chunks_written).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(2);
    expect(new Set(rows.map((r) => r.slug_path))).toEqual(new Set(['alpha', 'beta']));

    const alpha = rows.filter((r) => r.slug_path === 'alpha');
    expect(alpha.map((r) => r.ord)).toEqual(alpha.map((_, i) => i));
    expect(alpha[0].text).toContain('Paragraph 1 of Alpha');
  });

  it('writes nothing on a second sync of an unchanged repo, and keeps every row', async () => {
    await embedEverything();
    const before = await chunks();

    const stats = await sync();

    expect(stats.chunks_written).toBe(0);
    const after = await chunks();
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.every((r) => r.embedding !== null)).toBe(true);
  });

  it('re-chunks only the page that changed, and only what moved in it', async () => {
    await embedEverything();
    const before = await chunks();
    const betaBefore = before.filter((r) => r.slug_path === 'beta');
    const alphaBefore = before.filter((r) => r.slug_path === 'alpha');

    write({
      'docs/02-beta.md': PAGES['docs/02-beta.md'].replace(
        '# Beta',
        `# Beta\n\nA new opening paragraph. ${'novel '.repeat(120).trim()}`,
      ),
    });
    const stats = await sync();

    const alphaAfter = await chunks('alpha');
    expect(alphaAfter.map((r) => r.id)).toEqual(alphaBefore.map((r) => r.id));
    expect(alphaAfter.every((r) => r.embedding !== null)).toBe(true);

    const betaAfter = await chunks('beta');
    const survivors = betaAfter.filter((r) =>
      betaBefore.some((b) => b.content_hash === r.content_hash),
    );
    expect(survivors.length).toBeGreaterThan(0);
    for (const survivor of survivors) {
      const original = betaBefore.find((b) => b.content_hash === survivor.content_hash) as ChunkRow;
      expect(survivor.id).toBe(original.id);
      expect(survivor.embedding).not.toBeNull();
    }
    expect(
      survivors.some(
        (s) =>
          s.ord !== (betaBefore.find((b) => b.content_hash === s.content_hash) as ChunkRow).ord,
      ),
    ).toBe(true);

    const fresh = betaAfter.filter((r) => r.embedding === null);
    expect(fresh.length).toBeGreaterThan(0);
    expect(stats.chunks_written).toBe(fresh.length);

    expect(betaAfter.map((r) => r.ord)).toEqual(betaAfter.map((_, i) => i));
  });

  it("keeps a rejected subtree's chunks, exactly as it keeps its pages", async () => {
    write({
      'docs/03-gamma/.speicher.yaml': 'version: 1\naccess:\n  groups: [engineering]\n',
      'docs/03-gamma/index.md': body('Gamma', 'gamma'),
    });
    await sync();
    await embedEverything();
    const before = await chunks('gamma');
    expect(before.length).toBeGreaterThan(0);

    write({
      'docs/03-gamma/.speicher.yaml': 'version: 1\naccess:\n  groups: [no-such-group]\n',
    });
    const result = await harness.ingest.syncRepo(repoId, {
      workingTree,
      sha: FIXTURE_SHA,
      trigger: 'manual',
      now: new Date('2026-08-21T12:00:00Z'),
    });
    expect(result.stats.failed_subtrees.length).toBe(1);

    const after = await chunks('gamma');
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.every((r) => r.embedding !== null)).toBe(true);

    write({
      'docs/03-gamma/.speicher.yaml': 'version: 1\naccess:\n  groups: [engineering]\n',
    });
    await sync();
  });

  it("takes a deleted page's chunks with it", async () => {
    rmSync(join(workingTree, 'docs/02-beta.md'));
    await sync();

    expect(await chunks('beta')).toEqual([]);
    expect((await chunks('alpha')).length).toBeGreaterThan(0);
  });

  it('takes the whole repository with it when it is removed', async () => {
    await harness.ingest.removeRepo(repoId);
    expect(await chunks()).toEqual([]);
  });
});
