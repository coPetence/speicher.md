import { QueryTypes } from 'sequelize';

import { PUBLIC_PRINCIPAL } from '../../../../common/principals';
import { slugify } from '../../../../common/slug';
import { getSequelize } from '../../../../db/sequelize';
import type { PickListNote } from '../../config-form/config-fields';
import { memberUsage } from '../../member-usage';
import type { PickListProvider } from '.';

interface RepoRow {
  namespace: string;
  slug: string;
  has_config: boolean;
  last_status: 'never' | 'ok' | 'failed';
  public_refused: boolean;
}

export const repositories: PickListProvider = {
  async items(tenantId) {
    const [repos, usage] = await Promise.all([
      repoRows(tenantId),
      memberUsage(tenantId, PUBLIC_PRINCIPAL),
    ]);
    const published = new Set(usage.map((repo) => `${repo.namespace}/${repo.slug}`));
    return repos.map((repo) => {
      const name = nameOf(repo);
      const note = published.has(`${repo.namespace}/${repo.slug}`) ? null : noteOn(repo);
      return { value: name, label: name, note };
    });
  },
  keyOf(value) {
    const cut = value.lastIndexOf('/');
    return nameOf({ namespace: value.slice(0, cut), slug: value.slice(cut + 1) });
  },
  unknown: {
    level: 'warn',
    text: 'speicher.md does not know this repository. It may have been renamed or removed.',
  },
};

function nameOf(repo: { namespace: string; slug: string }): string {
  return `${slugify(repo.namespace)}/${repo.slug}`;
}

function noteOn(repo: RepoRow): PickListNote {
  if (repo.public_refused) {
    return {
      level: 'info',
      text: 'The .speicher.yaml of this repository grants public access. The pages of this repository will become public after the next sync.',
    };
  }
  if (repo.last_status === 'never') {
    return {
      level: 'info',
      text: 'This repository has not been synced yet, so it is not known whether its .speicher.yaml grants public access.',
    };
  }
  if (!repo.has_config) {
    return {
      level: 'warn',
      text: 'This repository has no .speicher.yaml yet, so it stays private. To publish its pages add a .speicher.yaml that grants public access.',
    };
  }
  return {
    level: 'warn',
    text: 'This .speicher.yaml of this repository does not grant public access, so it will stays private. Add public to its access to publish its pages.',
  };
}

async function repoRows(tenantId: string): Promise<RepoRow[]> {
  return getSequelize().query<RepoRow>(
    `SELECT r.namespace, r.slug, r.has_config, r.last_status,
            COALESCE((
              SELECT EXISTS (
                       SELECT 1 FROM jsonb_array_elements(run.findings) AS finding
                        WHERE finding->>'code' = 'public-not-enabled'
                     )
                FROM sync_runs run
               WHERE run.tenant_id = r.tenant_id AND run.repo_id = r.id
                 AND run.finished_at IS NOT NULL
               ORDER BY run.started_at DESC
               LIMIT 1
            ), false) AS public_refused
       FROM repos r
      WHERE r.tenant_id = :tenantId
      ORDER BY r.namespace, r.slug`,
    { type: QueryTypes.SELECT, replacements: { tenantId } },
  );
}
