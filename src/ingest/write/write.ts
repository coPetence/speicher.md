/**
 * Write a walked repository into the database
 *
 * Assets uploaded before the transaction to avoid holding the connection during blob I/O
 * Redirects collected before the transaction
 * All sync tables swept and rewritten in a single transaction
 * Failed subtrees kept from the prior sync
 * Chunks reconciled rather than fully replaced to preserve embeddings
 * Repo row stamped last to mark the sync as complete
 */

import { Sequelize } from 'sequelize';

import { BlobStore } from '../../assets/blob-store';
import { Repo } from '../../db/models';
import { Redirect, collectRedirects } from '../redirect-from';
import { adminSummary, authorSummary } from '../sync-summary';
import { WalkResult } from '../walk/walk';
import { uploadAssets, writeAssets } from './assets';
import { writeChunks } from './chunks';
import { writeDocuments } from './documents';
import { writeFolders } from './folders';
import { writeEdges, writeTerms } from './graph';
import { WritePlan, normaliseFailedSubtrees } from './plan';
import { replaceRedirects } from './redirects';
import { SyncVerdict, stampRepo } from './repo';
import { sweepExceptFailed } from './sweep';

/** Options for writeWalk */
export interface WriteWalkOptions {
  sequelize: Sequelize;
  blobs: BlobStore;
  repo: Repo;
  forgeKey: string;
  sha: string; // Git SHA being synced
  walk: WalkResult;
}

/** Result of writeWalk */
export interface WriteWalkResult {
  plan: WritePlan;
  verdict: SyncVerdict;
  redirects: Redirect[];
  assetsUploaded: number; // New uploads, not total assets
  chunksWritten: number; // New chunk rows inserted
}

/** Build plan and verdict from walk findings, then run the write transaction */
export async function writeWalk(options: WriteWalkOptions): Promise<WriteWalkResult> {
  const { sequelize, blobs, repo, forgeKey, sha, walk } = options;
  const findings = walk.findings;

  const assetsUploaded = await uploadAssets(blobs, repo.id, walk.assets);
  const redirects = collectRedirects(
    { namespace: repo.namespace, slug: repo.slug, forgeKey },
    walk.documents,
    findings,
  );

  const plan: WritePlan = {
    tenantId: repo.tenant_id,
    repoId: repo.id,
    namespace: repo.namespace,
    slug: repo.slug,
    forgeKey,
    sha,
    failed: normaliseFailedSubtrees(walk.failedSubtrees),
  };
  const verdict: SyncVerdict = findings.hasRejection
    ? { failed: true, adminError: adminSummary(findings), authorError: authorSummary(findings) }
    : { failed: false, adminError: null, authorError: null };

  let chunksWritten = 0;
  await sequelize.transaction(async (tx) => {
    const w = { sequelize, tx, plan };
    await sweepExceptFailed(w);
    await writeDocuments(w, walk.documents);
    await writeFolders(w, walk.folders);
    await writeAssets(w, walk.assets);
    await writeEdges(w, walk.edges);
    await writeTerms(w, walk.terms);
    chunksWritten = await writeChunks(w, walk.documents);
    await replaceRedirects(w, redirects);
    await stampRepo(w, walk, verdict);
  });

  return { plan, verdict, redirects, assetsUploaded, chunksWritten };
}
