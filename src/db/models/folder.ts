import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class Folder extends Model {
  declare id: string;
  declare tenant_id: string;
  declare repo_id: string;
  declare slug_path: string;
  declare source_path: string;
  declare parent_path: string | null;
  declare title: string;
  declare sort_order: number | null;
  declare sort_key: string;
  declare cover_path: string | null;
  declare icon: string | null;
  declare effective_principals: string[];
  declare config_source: Record<string, unknown>;
  declare commit_sha: string;
}

export function initFolder(sequelize: Sequelize): void {
  Folder.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      repo_id: DataTypes.UUID,
      slug_path: DataTypes.TEXT,
      source_path: DataTypes.TEXT,
      parent_path: DataTypes.TEXT,
      title: DataTypes.TEXT,
      sort_order: DataTypes.INTEGER,
      sort_key: DataTypes.TEXT,
      cover_path: DataTypes.TEXT,
      icon: DataTypes.TEXT,
      effective_principals: DataTypes.ARRAY(DataTypes.TEXT),
      config_source: DataTypes.JSONB,
      commit_sha: DataTypes.TEXT,
    },
    modelOptions(sequelize, 'folders'),
  );
}
