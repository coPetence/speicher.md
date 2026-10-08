import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class Repo extends Model {
  declare id: string;
  declare tenant_id: string;
  declare forge_id: string;
  declare installation_id: string | null;
  declare forge_repo_id: string;
  declare namespace: string;
  declare namespace_id: string | null;
  declare slug: string;
  declare branch: string;
  declare ingest_root: string;
  declare display_title: string | null;

  declare cover_path: string | null;
  declare maintainer_principals: string[];
  declare has_config: boolean;
  declare last_sha: string | null;
  declare last_run_at: Date | null;
  declare last_status: 'never' | 'ok' | 'failed';
  declare last_error: string | null;
  declare last_error_public: string | null;
  declare next_grant_review_at: Date | null;

  declare poll_interval_ms: number | null;
  declare created_at: Date;
  declare updated_at: Date;
}

export function initRepo(sequelize: Sequelize): void {
  Repo.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      forge_id: DataTypes.UUID,
      installation_id: DataTypes.UUID,
      forge_repo_id: DataTypes.TEXT,
      namespace: DataTypes.TEXT,
      namespace_id: DataTypes.TEXT,
      slug: DataTypes.TEXT,
      branch: DataTypes.TEXT,
      ingest_root: DataTypes.TEXT,
      display_title: DataTypes.TEXT,
      cover_path: DataTypes.TEXT,
      maintainer_principals: DataTypes.ARRAY(DataTypes.TEXT),
      has_config: DataTypes.BOOLEAN,
      last_sha: DataTypes.TEXT,
      last_run_at: DataTypes.DATE,
      last_status: DataTypes.TEXT,
      last_error: DataTypes.TEXT,
      last_error_public: DataTypes.TEXT,
      next_grant_review_at: DataTypes.DATE,
      poll_interval_ms: DataTypes.INTEGER,
      created_at: DataTypes.DATE,
      updated_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'repos'),
  );
}
