import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class Forge extends Model {
  declare id: string;
  declare tenant_id: string;
  declare key: string;
  declare type: string;
  declare is_primary: boolean;
  declare default_repository_owner: string | null;
  declare config: Record<string, unknown>;
}

export function initForge(sequelize: Sequelize): void {
  Forge.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      key: DataTypes.TEXT,
      type: DataTypes.TEXT,
      is_primary: DataTypes.BOOLEAN,
      default_repository_owner: DataTypes.TEXT,
      config: DataTypes.JSONB,
    },
    modelOptions(sequelize, 'forges'),
  );
}
