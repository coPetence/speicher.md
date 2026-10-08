import { DataTypes, Model, Sequelize } from 'sequelize';

import type { JobStatus } from '../../jobs/queue';
import { modelOptions, uuidPrimaryKey } from './shared';

export class Job extends Model {
  declare id: string;
  declare tenant_id: string;
  declare kind: string;
  declare payload: Record<string, unknown>;
  declare dedupe_key: string | null;
  declare status: JobStatus;
  declare run_after: Date;
  declare attempts: number;
  declare max_attempts: number;
  declare locked_until: Date | null;
  declare locked_by: string | null;
  declare last_error: string | null;
}

export function initJob(sequelize: Sequelize): void {
  Job.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      kind: DataTypes.TEXT,
      payload: DataTypes.JSONB,
      dedupe_key: DataTypes.TEXT,
      status: DataTypes.TEXT,
      run_after: DataTypes.DATE,
      attempts: DataTypes.INTEGER,
      max_attempts: DataTypes.INTEGER,
      locked_until: DataTypes.DATE,
      locked_by: DataTypes.TEXT,
      last_error: DataTypes.TEXT,
      created_at: DataTypes.DATE,
      updated_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'jobs'),
  );
}
