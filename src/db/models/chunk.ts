import { DataTypes, Model, Sequelize } from 'sequelize';

import { parseVector, Vector } from '../vector';
import { modelOptions, uuidPrimaryKey } from './shared';

export class Chunk extends Model {
  declare id: string;
  declare tenant_id: string;
  declare repo_id: string;

  declare slug_path: string;
  declare ord: number;
  declare text: string;
  declare content_hash: string;
  declare embedding: number[] | null;
  declare embedding_model: string | null;
  declare embedding_dim: number | null;
}

export function initChunk(sequelize: Sequelize): void {
  Chunk.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      repo_id: DataTypes.UUID,
      slug_path: DataTypes.TEXT,
      ord: DataTypes.INTEGER,
      text: DataTypes.TEXT,
      content_hash: DataTypes.TEXT,
      embedding: {
        // pgvector arrives from the driver as text like '[0.1,0.2]': the Vector type writes
        // an array as a vector, and the getter parses the text back into numbers
        type: new Vector(),
        get(this: Chunk): number[] | null {
          return parseVector(this.getDataValue('embedding'));
        },
      },
      embedding_model: DataTypes.TEXT,
      embedding_dim: DataTypes.INTEGER,
      created_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'chunks'),
  );
}
