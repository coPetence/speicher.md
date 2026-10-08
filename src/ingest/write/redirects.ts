import { QueryTypes } from 'sequelize';

import { Redirect } from '../redirect-from';
import { WriteTx, exec } from './plan';

export async function replaceRedirects(w: WriteTx, redirects: Redirect[]): Promise<void> {
  const { tenantId, repoId } = w.plan;
  await exec(
    w,
    `DELETE FROM redirects WHERE tenant_id = :tenantId AND repo_id = :repoId AND reason = 'redirect_from'`,
    QueryTypes.DELETE,
    { tenantId, repoId },
  );
  for (const redirect of redirects) {
    await exec(
      w,
      `INSERT INTO redirects (tenant_id, repo_id, from_path, to_path, reason)
       VALUES (:tenantId, :repoId, :from, :to, 'redirect_from')
       ON CONFLICT DO NOTHING`,
      QueryTypes.INSERT,
      { tenantId, repoId, from: redirect.from, to: redirect.to },
    );
  }
}
