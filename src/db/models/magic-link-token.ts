import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class MagicLinkToken extends Model {
  declare id: string;
  declare tenant_id: string;
  declare provider: string;
  declare email: string;
  declare token_hash: string;
  declare browser_binding: string | null;
  declare redirect_to: string | null;
  declare names_first_admin: boolean;
  declare expires_at: Date;
  declare consumed_at: Date | null;
}

export function initMagicLinkToken(sequelize: Sequelize): void {
  MagicLinkToken.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      provider: DataTypes.TEXT,
      email: DataTypes.TEXT,
      token_hash: DataTypes.TEXT,
      browser_binding: DataTypes.TEXT,
      redirect_to: DataTypes.TEXT,
      names_first_admin: DataTypes.BOOLEAN,
      expires_at: DataTypes.DATE,
      consumed_at: DataTypes.DATE,
      created_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'magic_link_tokens'),
  );
}
