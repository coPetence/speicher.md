import { Model, ModelStatic, Transaction } from 'sequelize';

import { LoginFlow, MagicLinkToken, OauthCode, OauthGrant, Session } from '../db/models';
import { getSequelize } from '../db/sequelize';

const CARRIED: ModelStatic<Model>[] = [Session, OauthGrant, OauthCode, MagicLinkToken, LoginFlow];

export interface CarriedRows {
  moved: Record<string, number>;
  total: number;
}

export async function carryProviderRows(
  tenantId: string,
  from: string,
  to: string,
): Promise<CarriedRows> {
  const moved: Record<string, number> = {};
  if (from === to) return { moved, total: 0 };

  await getSequelize().transaction(async (tx: Transaction) => {
    for (const model of CARRIED) {
      const [count] = await model.update({ provider: to } as Record<string, unknown>, {
        where: { tenant_id: tenantId, provider: from },
        transaction: tx,
      });
      if (count > 0) moved[model.tableName] = count;
    }
  });

  return { moved, total: Object.values(moved).reduce((sum, n) => sum + n, 0) };
}

export const CARRIED_TABLES = CARRIED.map((model) => model.tableName);
