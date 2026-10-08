import { QueryTypes, Sequelize } from 'sequelize';

import { WriteTx } from './plan';

const SYNC_TABLES: { table: string; pathColumn: string | null }[] = [
  { table: 'documents', pathColumn: 'slug_path' },
  { table: 'folders', pathColumn: 'slug_path' },
  { table: 'assets', pathColumn: 'slug_path' },
  { table: 'document_edges', pathColumn: 'source_slug_path' },
  { table: 'document_terms', pathColumn: 'source_slug_path' },
  { table: 'redirects', pathColumn: null },
  { table: 'chunks', pathColumn: null },
];

export async function sweepExceptFailed(w: WriteTx): Promise<void> {
  const { tenantId, repoId, failed } = w.plan;
  const replacements: Record<string, unknown> = { tenantId, repoId };
  failed.forEach((prefix, i) => {
    replacements[`p${i}`] = prefix;
    replacements[`like${i}`] = prefix === '' ? '%' : `${prefix}/%`;
  });

  for (const { table, pathColumn } of SYNC_TABLES) {
    if (pathColumn === null) continue;
    const guard =
      failed.length > 0
        ? `AND NOT (${failed
            .map((_, i) => `(${pathColumn} = :p${i} OR ${pathColumn} LIKE :like${i})`)
            .join(' OR ')})`
        : '';
    await w.sequelize.query(
      `DELETE FROM ${table} WHERE tenant_id = :tenantId AND repo_id = :repoId ${guard}`,
      { transaction: w.tx, type: QueryTypes.DELETE, replacements },
    );
  }
}

export async function purgeRepoRows(sequelize: Sequelize, repoId: string): Promise<void> {
  await sequelize.transaction(async (tx) => {
    for (const { table } of SYNC_TABLES) {
      await sequelize.query(`DELETE FROM ${table} WHERE repo_id = :repoId`, {
        transaction: tx,
        type: QueryTypes.DELETE,
        replacements: { repoId },
      });
    }
  });
}
