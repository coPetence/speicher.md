import { QueryTypes } from 'sequelize';

import { chunkDocument } from '../chunk';
import { IngestedDocument } from '../ingested';
import { WriteTx, exec, isUnder, retained } from './plan';

export async function writeChunks(w: WriteTx, documents: IngestedDocument[]): Promise<number> {
  const { plan } = w;
  const pages = retained(plan, documents, (d) => d.slugPath);
  let written = 0;

  const existing = await w.sequelize.query<{
    slug_path: string;
    ord: number;
    content_hash: string;
  }>(
    `SELECT slug_path, ord, content_hash FROM chunks
      WHERE tenant_id = :tenantId AND repo_id = :repoId
      ORDER BY slug_path, ord`,
    {
      transaction: w.tx,
      type: QueryTypes.SELECT,
      replacements: { tenantId: plan.tenantId, repoId: plan.repoId },
    },
  );
  const stored = new Map<string, { ord: number; hash: string }[]>();
  for (const row of existing) {
    const list = stored.get(row.slug_path) ?? [];
    list.push({ ord: row.ord, hash: row.content_hash });
    stored.set(row.slug_path, list);
  }

  for (const doc of pages) {
    const chunks = chunkDocument(doc.plain);
    const before = stored.get(doc.slugPath) ?? [];
    if (unchangedChunks(before, chunks)) continue;

    const page = { tenantId: plan.tenantId, repoId: plan.repoId, slugPath: doc.slugPath };

    await exec(
      w,
      `UPDATE chunks SET ord = -1 - ord
        WHERE tenant_id = :tenantId AND repo_id = :repoId AND slug_path = :slugPath`,
      QueryTypes.UPDATE,
      page,
    );

    const parked = new Map<string, number[]>();
    for (const row of before) {
      const list = parked.get(row.hash) ?? [];
      list.push(row.ord);
      parked.set(row.hash, list);
    }

    for (const chunk of chunks) {
      const from = parked.get(chunk.contentHash)?.shift();
      if (from !== undefined) {
        await exec(
          w,
          `UPDATE chunks SET ord = :ord, text = :text
            WHERE tenant_id = :tenantId AND repo_id = :repoId AND slug_path = :slugPath
              AND ord = :parkedOrd`,
          QueryTypes.UPDATE,
          { ...page, ord: chunk.ord, parkedOrd: -1 - from, text: chunk.text },
        );
        continue;
      }
      await exec(
        w,
        `INSERT INTO chunks (tenant_id, repo_id, slug_path, ord, text, content_hash)
         VALUES (:tenantId, :repoId, :slugPath, :ord, :text, :contentHash)`,
        QueryTypes.INSERT,
        { ...page, ord: chunk.ord, text: chunk.text, contentHash: chunk.contentHash },
      );
      written += 1;
    }

    await exec(
      w,
      `DELETE FROM chunks
        WHERE tenant_id = :tenantId AND repo_id = :repoId AND slug_path = :slugPath AND ord < 0`,
      QueryTypes.DELETE,
      page,
    );
  }

  const live = new Set(pages.map((d) => d.slugPath));
  for (const slugPath of stored.keys()) {
    if (live.has(slugPath) || isUnder(plan.failed, slugPath)) continue;
    await exec(
      w,
      `DELETE FROM chunks
        WHERE tenant_id = :tenantId AND repo_id = :repoId AND slug_path = :slugPath`,
      QueryTypes.DELETE,
      { tenantId: plan.tenantId, repoId: plan.repoId, slugPath },
    );
  }

  return written;
}

function unchangedChunks(
  stored: { ord: number; hash: string }[],
  chunks: { ord: number; contentHash: string }[],
): boolean {
  if (stored.length !== chunks.length) return false;
  return chunks.every((chunk, i) => {
    const row = stored[i] as { ord: number; hash: string };
    return row.ord === chunk.ord && row.hash === chunk.contentHash;
  });
}
