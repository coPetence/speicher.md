import { DataTypes, Model, Sequelize } from 'sequelize';

import { modelOptions } from './shared';

/**
 * Composite primary key (forge_id, delivery_id)
 */
export class WebhookDelivery extends Model {
  declare forge_id: string;
  declare delivery_id: string;
  declare event: string | null;
  declare received_at: Date;
}

export function initWebhookDelivery(sequelize: Sequelize): void {
  WebhookDelivery.init(
    {
      forge_id: { type: DataTypes.UUID, primaryKey: true },
      delivery_id: { type: DataTypes.TEXT, primaryKey: true },
      event: DataTypes.TEXT,
      received_at: DataTypes.DATE,
    },
    modelOptions(sequelize, 'webhook_deliveries'),
  );
}
