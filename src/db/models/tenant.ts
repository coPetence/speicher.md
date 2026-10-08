import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class Tenant extends Model {
  declare id: string;
  declare slug: string;
  declare hostname: string | null;
}

export function initTenant(sequelize: Sequelize): void {
  Tenant.init(
    {
      id: uuidPrimaryKey,
      slug: DataTypes.TEXT,
      hostname: DataTypes.TEXT,
      created_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'tenants'),
  );
}
