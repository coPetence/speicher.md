import { QueryTypes } from 'sequelize';

import { IngestedEdge, IngestedTerm } from '../ingested';
import { WriteTx, exec, retained } from './plan';

export async function writeEdges(w: WriteTx, edges: IngestedEdge[]): Promise<void> {
  const { plan } = w;
  for (const edge of retained(plan, edges, (e) => e.sourceSlugPath)) {
    await exec(
      w,
      `INSERT INTO document_edges (
         tenant_id, repo_id, source_slug_path, kind, target_repo_id, target_slug_path,
         target_fragment, ordinal, commit_sha
       ) VALUES (
         :tenantId, :repoId, :source, :kind, :targetRepoId, :target, :fragment, :ordinal, :sha
       )
       ON CONFLICT DO NOTHING`,
      QueryTypes.INSERT,
      {
        tenantId: plan.tenantId,
        repoId: plan.repoId,
        targetRepoId: edge.targetRepoId ?? plan.repoId,
        source: edge.sourceSlugPath,
        kind: edge.kind,
        target: edge.targetSlugPath,
        fragment: edge.targetFragment,
        ordinal: edge.ordinal,
        sha: plan.sha,
      },
    );
  }
}

export async function writeTerms(w: WriteTx, terms: IngestedTerm[]): Promise<void> {
  const { plan } = w;
  for (const term of retained(plan, terms, (t) => t.sourceSlugPath)) {
    await exec(
      w,
      `INSERT INTO document_terms (
         tenant_id, repo_id, source_slug_path, term, label, ordinal, commit_sha
       ) VALUES (:tenantId, :repoId, :source, :term, :label, :ordinal, :sha)
       ON CONFLICT DO NOTHING`,
      QueryTypes.INSERT,
      {
        tenantId: plan.tenantId,
        repoId: plan.repoId,
        source: term.sourceSlugPath,
        term: term.term,
        label: term.label,
        ordinal: term.ordinal,
        sha: plan.sha,
      },
    );
  }
}
