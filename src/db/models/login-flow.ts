import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class LoginFlow extends Model {
  declare id: string;
  declare tenant_id: string;
  declare provider: string;
  declare state: string;
  declare nonce: string;
  declare code_verifier: string;
  declare redirect_to: string;

  declare names_first_admin: boolean;
  declare expires_at: Date;
}

export function initLoginFlow(sequelize: Sequelize): void {
  LoginFlow.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      provider: DataTypes.TEXT,
      state: DataTypes.TEXT,
      nonce: DataTypes.TEXT,
      code_verifier: DataTypes.TEXT,
      redirect_to: DataTypes.TEXT,
      names_first_admin: DataTypes.BOOLEAN,
      expires_at: DataTypes.DATE,
      created_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'login_flows'),
  );
}
