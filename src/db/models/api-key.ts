import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class ApiKey extends Model {
  declare id: string;
  declare tenant_id: string;
  declare principal: string;
  declare provider: string;
  declare subject: string;
  declare email: string | null;
  declare name: string;
  declare hash: string;
  declare scopes: string[];
  declare raw_group_ids: string[];
  declare expires_at: Date;
  declare last_used_at: Date | null;
  declare revoked_at: Date | null;
}

export function initApiKey(sequelize: Sequelize): void {
  ApiKey.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      principal: DataTypes.TEXT,
      provider: DataTypes.TEXT,
      subject: DataTypes.TEXT,
      email: DataTypes.TEXT,
      name: DataTypes.TEXT,
      hash: DataTypes.TEXT,
      scopes: DataTypes.ARRAY(DataTypes.TEXT),
      raw_group_ids: DataTypes.ARRAY(DataTypes.TEXT),
      expires_at: DataTypes.DATE,
      last_used_at: DataTypes.DATE,
      revoked_at: DataTypes.DATE,
      created_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'api_keys'),
  );
}
