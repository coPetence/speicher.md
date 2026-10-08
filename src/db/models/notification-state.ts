import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions, uuidPrimaryKey } from './shared';

export class NotificationState extends Model {
  declare id: string;
  declare tenant_id: string;
  declare subject_key: string;
  declare kind: string;
  declare last_state: string;
  declare last_sent_at: Date | null;
}

export function initNotificationState(sequelize: Sequelize): void {
  NotificationState.init(
    {
      id: uuidPrimaryKey,
      tenant_id: DataTypes.UUID,
      subject_key: DataTypes.TEXT,
      kind: DataTypes.TEXT,
      last_state: DataTypes.TEXT,
      last_sent_at: DataTypes.DATE,
      updated_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'notification_state'),
  );
}
