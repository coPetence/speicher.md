import { QueryTypes } from 'sequelize';

import { toPgTextArray } from '../../db/pg-array';
import { IngestedFolder } from '../ingested';
import { WriteTx, exec, retained } from './plan';

export async function writeFolders(w: WriteTx, folders: IngestedFolder[]): Promise<void> {
  const { plan } = w;
  for (const folder of retained(plan, folders, (f) => f.slugPath)) {
    await exec(
      w,
      `INSERT INTO folders (
         tenant_id, repo_id, slug_path, source_path, parent_path, title,
         sort_order, sort_key, cover_path, icon, effective_principals, config_source,
         commit_sha
       ) VALUES (
         :tenantId, :repoId, :slugPath, :sourcePath, :parentPath, :title,
         :sortOrder, :sortKey, :coverPath, :icon, CAST(:principals AS text[]),
         CAST(:configSource AS jsonb), :sha
       )`,
      QueryTypes.INSERT,
      {
        tenantId: plan.tenantId,
        repoId: plan.repoId,
        slugPath: folder.slugPath,
        sourcePath: folder.sourcePath,
        parentPath: folder.parentPath,
        title: folder.title,
        sortOrder: folder.sortOrder,
        sortKey: folder.sortKey,
        coverPath: folder.coverPath,
        icon: folder.icon,
        principals: toPgTextArray(folder.principals),
        configSource: JSON.stringify(folder.configSource),
        sha: plan.sha,
      },
    );
  }
}
