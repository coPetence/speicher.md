import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class OauthGrant extends Model {
  declare id: string;
  declare tenant_id: string;
  declare principal: string;
  declare client_id: string;
  declare client_name: string | null;
  declare resource: string;
  declare access_hash: string;
  declare refresh_hash: string | null;
  declare scopes: string[];
  declare provider: string;
  declare subject: string;
  declare email: string | null;
  declare raw_group_ids: string[];
  declare access_expires_at: Date;
  declare refresh_expires_at: Date | null;
  declare last_used_at: Date | null;
  declare revoked_at: Date | null;
}

export function initOauthGrant(sequelize: Sequelize): void {
  OauthGrant.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      principal: DataTypes.TEXT,
      client_id: DataTypes.TEXT,
      client_name: DataTypes.TEXT,
      resource: DataTypes.TEXT,
      access_hash: DataTypes.TEXT,
      refresh_hash: DataTypes.TEXT,
      scopes: DataTypes.ARRAY(DataTypes.TEXT),
      provider: DataTypes.TEXT,
      subject: DataTypes.TEXT,
      email: DataTypes.TEXT,
      raw_group_ids: DataTypes.ARRAY(DataTypes.TEXT),
      access_expires_at: DataTypes.DATE,
      refresh_expires_at: DataTypes.DATE,
      last_used_at: DataTypes.DATE,
      revoked_at: DataTypes.DATE,
      created_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'oauth_grants'),
  );
}
