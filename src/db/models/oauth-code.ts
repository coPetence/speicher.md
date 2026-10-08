import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class OauthCode extends Model {
  declare id: string;
  declare tenant_id: string;
  declare code_hash: string;
  declare client_id: string;
  declare client_name: string | null;
  declare redirect_uri: string;
  declare resource: string;
  declare scope: string;
  declare code_challenge: string;
  declare provider: string;
  declare subject: string;
  declare email: string | null;
  declare raw_group_ids: string[];
  declare expires_at: Date;
}

export function initOauthCode(sequelize: Sequelize): void {
  OauthCode.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      code_hash: DataTypes.TEXT,
      client_id: DataTypes.TEXT,
      client_name: DataTypes.TEXT,
      redirect_uri: DataTypes.TEXT,
      resource: DataTypes.TEXT,
      scope: DataTypes.TEXT,
      code_challenge: DataTypes.TEXT,
      provider: DataTypes.TEXT,
      subject: DataTypes.TEXT,
      email: DataTypes.TEXT,
      raw_group_ids: DataTypes.ARRAY(DataTypes.TEXT),
      expires_at: DataTypes.DATE,
      created_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'oauth_codes'),
  );
}
