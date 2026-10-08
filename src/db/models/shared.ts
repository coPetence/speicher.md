import { DataTypes, InitOptions, Sequelize } from 'sequelize';

/** modelOptions returns the options every model is initialised with, for the given table */
export function modelOptions(sequelize: Sequelize, modelName: string): InitOptions {
  return { sequelize, modelName, timestamps: false, underscored: true, freezeTableName: true };
}

/** A UUID primary key, generated on insert */
export const uuidPrimaryKey = {
  type: DataTypes.UUID,
  primaryKey: true,
  defaultValue: DataTypes.UUIDV4,
};
