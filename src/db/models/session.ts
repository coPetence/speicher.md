import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class Session extends Model {
  declare id: string;
  declare tenant_id: string;
  declare token_hash: string;
  declare provider: string;
  declare subject: string;
  declare email: string | null;
  declare display_name: string | null;
  declare raw_group_ids: string[];
  declare groups_fetched_at: Date | null;

  declare is_setup: boolean;
  declare expires_at: Date;
}

export function initSession(sequelize: Sequelize): void {
  Session.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      token_hash: DataTypes.TEXT,
      provider: DataTypes.TEXT,
      subject: DataTypes.TEXT,
      email: DataTypes.TEXT,
      display_name: DataTypes.TEXT,
      raw_group_ids: DataTypes.ARRAY(DataTypes.TEXT),
      groups_fetched_at: DataTypes.DATE,
      is_setup: DataTypes.BOOLEAN,
      created_at: DataTypes.DATE,
      expires_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'sessions'),
  );
}
