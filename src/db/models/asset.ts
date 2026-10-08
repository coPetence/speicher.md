import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class Asset extends Model {
  declare id: string;
  declare tenant_id: string;
  declare repo_id: string;
  declare slug_path: string;
  declare source_path: string;
  declare parent_path: string;
  declare mime: string;
  declare size_bytes: string | number;
  declare effective_principals: string[];
  declare content_hash: string;
  declare commit_sha: string;
}

export function initAsset(sequelize: Sequelize): void {
  Asset.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      repo_id: DataTypes.UUID,
      slug_path: DataTypes.TEXT,
      source_path: DataTypes.TEXT,
      parent_path: DataTypes.TEXT,
      mime: DataTypes.TEXT,
      size_bytes: DataTypes.BIGINT,
      effective_principals: DataTypes.ARRAY(DataTypes.TEXT),
      content_hash: DataTypes.TEXT,
      commit_sha: DataTypes.TEXT,
      updated_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'assets'),
  );
}
