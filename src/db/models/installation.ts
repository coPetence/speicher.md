import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class Installation extends Model {
  declare id: string;
  declare tenant_id: string;
  declare forge_id: string;
  declare forge_installation_id: string;
  declare namespace: string;
  declare namespace_id: string | null;
  declare account_type: string;
  declare suspended_at: Date | null;
}

export function initInstallation(sequelize: Sequelize): void {
  Installation.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      forge_id: DataTypes.UUID,
      forge_installation_id: DataTypes.TEXT,
      namespace: DataTypes.TEXT,
      namespace_id: DataTypes.TEXT,
      account_type: DataTypes.TEXT,
      suspended_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'installations'),
  );
}
