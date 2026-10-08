import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions } from './shared';

export class InstanceState extends Model {
  declare key: string;
  declare value: unknown;
  declare updated_at: Date;
}

export function initInstanceState(sequelize: Sequelize): void {
  InstanceState.init(
    {
      key: { type: DataTypes.TEXT, primaryKey: true },
      value: DataTypes.JSONB,
      updated_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'instance_state'),
  );
}
