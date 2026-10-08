/**
 * Carrying a provider's rows when its short id changes
 *
 * A provider's key *is* its identity: every grant is written against it, and a
 * caller's principals are built from it (`user:<provider>:<subject>`). So
 * `renameProvider` rewrites the key, `auth.default_provider`, every group source
 * and every individual administrator — the whole document. What it cannot reach
 * is the rows this instance has already minted under the old spelling, and each
 * of those names the provider too.
 *
 * Left behind, they resolve to nobody. That fails *closed*, which is the right
 * direction and still wrong: the administrator who made the edit is signed out of
 * the instance they were administering, with nothing said, and the repair is to
 * clear a cookie. Two of the three durable tables have no cookie to clear —
 * an API key and an OAuth grant simply stop resolving, and an agent holding one
 * becomes anonymous without an error anywhere.
 *
 * This is not SPR-66. That one is a provider whose `issuer` is repointed while
 * its id stays: the session goes on resolving, under a *different* directory, and
 * fails open. Carrying rows does not address it and an issuer fingerprint does
 * not address this. The two are separate hazards that share a sentence.
 */

import { Model, ModelStatic, Transaction } from 'sequelize';

import { ApiKey, LoginFlow, MagicLinkToken, OauthCode, OauthGrant, Session } from '../db/models';
import { getSequelize } from '../db/sequelize';

/**
 * Every table that stores a provider id, most consequential first.
 *
 * The last three hold something in flight — a login part-way through, an unspent
 * magic link, an authorization code — and are carried for the same reason as the
 * rest rather than deleted: a rename is not a reason for a sign-in somebody is
 * half way through to fail, and "it broke once and worked when I retried" is the
 * report nobody can act on.
 */
const CARRIED: ModelStatic<Model>[] = [
  Session,
  OauthGrant,
  ApiKey,
  OauthCode,
  MagicLinkToken,
  LoginFlow,
];

export interface CarriedRows {
  /** Rows moved, by table name — for the log, and for the test to read. */
  moved: Record<string, number>;
  total: number;
}

/**
 * Point every row minted under `from` at `to`.
 *
 * In one transaction, so the tables cannot disagree about which name a caller
 * holds. It runs *after* the configuration version is stored: the save is the
 * step that can be refused, and moving the rows first would leave them naming a
 * provider no document has.
 */
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
