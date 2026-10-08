import { QueryTypes } from 'sequelize';

import { BlobStore } from '../../assets/blob-store';
import { toPgTextArray } from '../../db/pg-array';
import { IngestedAsset } from '../ingested';
import { WriteTx, exec, retained } from './plan';

export async function uploadAssets(
  blobs: BlobStore,
  repoId: string,
  assets: IngestedAsset[],
): Promise<number> {
  let uploaded = 0;
  for (const asset of assets) {
    if (await blobs.exists(repoId, asset.contentHash)) continue;
    await blobs.put(repoId, asset.contentHash, { path: asset.absolutePath });
    uploaded += 1;
  }
  return uploaded;
}

export async function writeAssets(w: WriteTx, assets: IngestedAsset[]): Promise<void> {
  const { plan } = w;
  for (const asset of retained(plan, assets, (a) => a.slugPath)) {
    await exec(
      w,
      `INSERT INTO assets (
         tenant_id, repo_id, slug_path, source_path, parent_path, mime, size_bytes,
         effective_principals, content_hash, commit_sha, updated_at
       ) VALUES (
         :tenantId, :repoId, :slugPath, :sourcePath, :parentPath, :mime, :sizeBytes,
         CAST(:principals AS text[]), :contentHash, :sha, now()
       )`,
      QueryTypes.INSERT,
      {
        tenantId: plan.tenantId,
        repoId: plan.repoId,
        slugPath: asset.slugPath,
        sourcePath: asset.sourcePath,
        parentPath: asset.parentPath,
        mime: asset.mime,
        sizeBytes: asset.sizeBytes,
        principals: toPgTextArray(asset.principals),
        contentHash: asset.contentHash,
        sha: plan.sha,
      },
    );
  }
}
