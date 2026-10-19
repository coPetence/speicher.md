import { QueryTypes } from 'sequelize';

import { ContentReports } from '../../../authz/content/reports';
import { PUBLIC_PRINCIPAL } from '../../../common/principals';
import { slugify } from '../../../common/slug';
import { getSequelize } from '../../../db/sequelize';
import type { PickListField, PickListNote } from '../config-form/config-fields';
import { allFields } from '../config-form/model';
import type { ConfigSectionPayload } from './payloads';

interface RepoRow {
  id: string;
  namespace: string;
  slug: string;
  has_config: boolean;
  last_status: 'never' | 'ok' | 'failed';
  public_refused: boolean;
}

interface KnownRepo extends RepoRow {
  public_pages: boolean;
}

export async function stampPickListOptions(
  tenantId: string,
  payload: ConfigSectionPayload,
): Promise<void> {
  if (!payload.section) return;
  const fields = allFields([payload.section]).filter(
    (field): field is PickListField =>
      field.kind === 'pick-list' && field.source === 'repositories',
  );
  if (fields.length === 0) return;

  const known = new Map((await knownRepos(tenantId)).map((repo) => [nameOf(repo), repo]));
  for (const field of fields) {
    const listed = new Set(field.values.map(normalised));
    field.options = [...known.entries()]
      .filter(([name]) => !listed.has(name))
      .map(([name, repo]) => ({ value: name, label: name, note: noteOn(repo) }));
    field.entries = field.values.map((value) => ({
      value,
      note: noteOn(known.get(normalised(value))),
      offered: known.has(normalised(value)),
    }));
  }
}

function nameOf(repo: { namespace: string; slug: string }): string {
  return `${slugify(repo.namespace)}/${repo.slug}`;
}

function normalised(entry: string): string {
  const cut = entry.lastIndexOf('/');
  return nameOf({ namespace: entry.slice(0, cut), slug: entry.slice(cut + 1) });
}

function noteOn(repo: KnownRepo | undefined): PickListNote {
  if (!repo) {
    return {
      level: 'warn',
      text: 'Speicher does not know this repository. It may have been renamed or removed.',
    };
  }
  if (repo.public_pages) return null;
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

async function knownRepos(tenantId: string): Promise<KnownRepo[]> {
  const [repos, published] = await Promise.all([
    repoRows(tenantId),
    new ContentReports().reposReadableBy(tenantId, PUBLIC_PRINCIPAL),
  ]);
  return repos.map((repo) => ({ ...repo, public_pages: published.has(repo.id) }));
}

async function repoRows(tenantId: string): Promise<RepoRow[]> {
  return getSequelize().query<RepoRow>(
    `SELECT r.id, r.namespace, r.slug, r.has_config, r.last_status,
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
