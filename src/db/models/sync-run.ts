import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class SyncRun extends Model {
  declare id: string;
  declare tenant_id: string;
  declare repo_id: string;
  declare sha: string | null;
  declare trigger: string;
  declare started_at: Date;
  declare finished_at: Date | null;
  declare status: 'running' | 'ok' | 'failed';
  declare stats: Record<string, unknown>;
  declare findings: unknown[];
  declare error: string | null;
}

export function initSyncRun(sequelize: Sequelize): void {
  SyncRun.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      repo_id: DataTypes.UUID,
      sha: DataTypes.TEXT,
      trigger: DataTypes.TEXT,
      started_at: DataTypes.DATE,
      finished_at: DataTypes.DATE,
      status: DataTypes.TEXT,
      stats: DataTypes.JSONB,
      findings: DataTypes.JSONB,
      error: DataTypes.TEXT,
    },
    modelOptions(sequelize, 'sync_runs'),
  );
}
