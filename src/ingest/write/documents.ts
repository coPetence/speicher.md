import { QueryTypes } from 'sequelize';

import { toPgTextArray } from '../../db/pg-array';
import { IngestedDocument } from '../ingested';
import { WriteTx, exec, retained } from './plan';

export async function writeDocuments(w: WriteTx, documents: IngestedDocument[]): Promise<void> {
  const { plan } = w;
  for (const doc of retained(plan, documents, (d) => d.slugPath)) {
    await exec(
      w,
      `INSERT INTO documents (
         tenant_id, repo_id, slug_path, source_path, parent_path, title, description,
         html, markdown, plain, is_index, indexable, effective_principals, config_source,
         content_hash, commit_sha, sort_order, sort_key, cover_path, icon,
         repo_namespace, repo_slug, forge_key, updated_at
       ) VALUES (
         :tenantId, :repoId, :slugPath, :sourcePath, :parentPath, :title, :description,
         :html, :markdown, :plain, :isIndex, :indexable, CAST(:principals AS text[]),
         CAST(:configSource AS jsonb), :contentHash, :sha, :sortOrder, :sortKey, :coverPath,
         :icon, :namespace, :slug, :forgeKey, now()
       )`,
      QueryTypes.INSERT,
      {
        tenantId: plan.tenantId,
        repoId: plan.repoId,
        slugPath: doc.slugPath,
        sourcePath: doc.sourcePath,
        parentPath: doc.parentPath,
        title: doc.title,
        description: doc.description,
        html: doc.html,
        markdown: doc.markdown,
        plain: doc.plain,
        isIndex: doc.isIndex,
        indexable: doc.indexable,
        principals: toPgTextArray(doc.principals),
        configSource: JSON.stringify(doc.configSource),
        contentHash: doc.contentHash,
        sha: plan.sha,
        sortOrder: doc.sortOrder,
        sortKey: doc.sortKey,
        coverPath: doc.coverPath,
        icon: doc.icon,
        namespace: plan.namespace,
        slug: plan.slug,
        forgeKey: plan.forgeKey,
      },
    );
  }
}
