import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class Document extends Model {
  declare id: string;
  declare tenant_id: string;
  declare repo_id: string;
  declare slug_path: string;
  declare source_path: string;
  declare parent_path: string;
  declare title: string;
  declare description: string | null;
  declare html: string;
  declare markdown: string;
  declare plain: string;
  declare is_index: boolean;
  declare indexable: boolean;
  declare effective_principals: string[];
  declare config_source: Record<string, unknown>;
  declare content_hash: string;
  declare commit_sha: string;
  declare sort_order: number | null;
  declare sort_key: string;
  declare cover_path: string | null;
  declare icon: string | null;
  declare repo_namespace: string;
  declare repo_slug: string;
  declare forge_key: string;
  declare updated_at: Date;
}

export function initDocument(sequelize: Sequelize): void {
  Document.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      repo_id: DataTypes.UUID,
      slug_path: DataTypes.TEXT,
      source_path: DataTypes.TEXT,
      parent_path: DataTypes.TEXT,
      title: DataTypes.TEXT,
      description: DataTypes.TEXT,
      html: DataTypes.TEXT,
      markdown: DataTypes.TEXT,
      plain: DataTypes.TEXT,
      is_index: DataTypes.BOOLEAN,
      indexable: DataTypes.BOOLEAN,

      effective_principals: DataTypes.ARRAY(DataTypes.TEXT),
      config_source: DataTypes.JSONB,
      content_hash: DataTypes.TEXT,
      commit_sha: DataTypes.TEXT,
      sort_order: DataTypes.INTEGER,
      sort_key: DataTypes.TEXT,
      cover_path: DataTypes.TEXT,
      icon: DataTypes.TEXT,
      repo_namespace: DataTypes.TEXT,
      repo_slug: DataTypes.TEXT,
      forge_key: DataTypes.TEXT,
      updated_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'documents'),
  );
}
