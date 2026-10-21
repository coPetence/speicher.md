/**
 * Deletes expired sessions, expired authorization codes,
 * and OAuth grants that are revoked or past their refresh expiry
 */
import { Op } from 'sequelize';

import { OauthCode, OauthGrant, Session, initModels } from '../db/models';

export interface AuthSweepResult {
  sessions: number;
  codes: number;
  connections: number;
}

export async function sweepExpiredAuth(now: Date = new Date()): Promise<AuthSweepResult> {
  initModels();
  const sessions = await Session.destroy({ where: { expires_at: { [Op.lt]: now } } });
  const codes = await OauthCode.destroy({ where: { expires_at: { [Op.lt]: now } } });
  const connections = await OauthGrant.destroy({
    where: {
      [Op.or]: [{ revoked_at: { [Op.ne]: null } }, { refresh_expires_at: { [Op.lt]: now } }],
    },
  });
  return { sessions, codes, connections };
}
