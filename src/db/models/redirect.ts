import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class Redirect extends Model {
  declare id: string;
  declare tenant_id: string;
  declare repo_id: string | null;
  declare from_path: string;
  declare to_path: string;
  declare reason: string;
  declare created_at: Date;
  declare retired_at: Date | null;
}

export function initRedirect(sequelize: Sequelize): void {
  Redirect.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      repo_id: DataTypes.UUID,
      from_path: DataTypes.TEXT,
      to_path: DataTypes.TEXT,
      reason: DataTypes.TEXT,
      created_at: DataTypes.DATE,
      retired_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'redirects'),
  );
}
