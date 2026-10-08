import { Repo } from '../../db/models';
import { WalkResult } from '../walk/walk';
import { WriteTx } from './plan';

export const DIRECTORY_RECHECK_MS = 24 * 60 * 60 * 1000;

export interface SyncVerdict {
  failed: boolean;
  adminError: string | null;
  authorError: string | null;
}

export async function stampRepo(w: WriteTx, walk: WalkResult, verdict: SyncVerdict): Promise<void> {
  const directoryRecheck = new Date(Date.now() + DIRECTORY_RECHECK_MS);
  const nextReview =
    walk.nextExpiry && walk.nextExpiry < directoryRecheck ? walk.nextExpiry : directoryRecheck;

  await Repo.update(
    {
      ingest_root: walk.repo.ingestRoot,
      display_title: walk.repo.displayTitle,
      cover_path: walk.repo.coverPath,
      maintainer_principals: walk.repo.maintainerPrincipals,
      has_config: true,
      last_sha: w.plan.sha,
      last_run_at: new Date(),
      last_status: verdict.failed ? 'failed' : 'ok',
      last_error: verdict.adminError,
      last_error_public: verdict.authorError,
      next_grant_review_at: nextReview,
      updated_at: new Date(),
    },
    { where: { id: w.plan.repoId }, transaction: w.tx },
  );
}
