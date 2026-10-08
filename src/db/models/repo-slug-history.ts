import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class RepoSlugHistory extends Model {
  declare id: string;
  declare tenant_id: string;
  declare repo_id: string;
  declare namespace: string;
  declare old_slug: string;
  declare retired_at: Date | null;
  declare retired_by_repo_id: string | null;
}

export function initRepoSlugHistory(sequelize: Sequelize): void {
  RepoSlugHistory.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      repo_id: DataTypes.UUID,
      namespace: DataTypes.TEXT,
      old_slug: DataTypes.TEXT,
      created_at: DataTypes.DATE,
      retired_at: DataTypes.DATE,
      retired_by_repo_id: DataTypes.UUID,
    },
    modelOptions(sequelize, 'repo_slug_history'),
  );
}
