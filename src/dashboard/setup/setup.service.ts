/**
 * Setup claim codes before the first admin login
 *
 * A claim is a code shared with a trusted person and an opaque token cookie
 * Mint a code, the trusted person approves it, then redeem the token for a
 * session with admin powers
 * Open while first_admin_login_at is NULL; latchFirstAdminLogin stamps it shut
 * reopen clears the stamp
 */

import { Injectable } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';

import { hashToken, mintToken } from '../../auth/tokens';
import { SetupReachRepository } from '../../authz/content/setup-reach.repository';
import { Principal } from '../../common/principals';
import { ConfigSource } from '../../config/types';
import { getSequelize } from '../../db/sequelize';
import { mintClaimCode } from './claim-code';

/** Claims expire after one hour */
export const CLAIM_TTL_MS = 60 * 60 * 1000;

/** Cap unapproved claims per tenant to bound storage */
export const MAX_LIVE_CLAIMS = 100;

export interface PendingClaim {
  code: string;
  origin: string;
  created_at: Date;
  approved_at: Date | null;
}

export interface MintedClaim {
  code: string;

  token: string;
  expiresAt: Date;
}

export type ApprovalResult =
  | { status: 'approved'; claim: PendingClaim }
  | { status: 'unknown' }
  | { status: 'already-approved'; claim: PendingClaim }
  | { status: 'closed' };

@Injectable()
export class SetupService {
  private get db(): Sequelize {
    return getSequelize();
  }

  /**
   * claimWindowOpen returns whether the tenant with the given tenantId can still be
   * claimed. This is the case until an administrator logs in for the first time.
   */
  async claimWindowOpen(tenantId: string): Promise<boolean> {
    const [row] = await this.db.query<{ window_open: boolean }>(
      `SELECT (first_admin_login_at IS NULL) AS window_open FROM tenants WHERE id = :tenantId`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
    return row?.window_open === true;
  }

  /**
   * showsClaimPage returns whether `GET /` serves the claim page for the tenant with
   * the given tenantId, judged from the instance's config source and administrator.
   */
  async showsClaimPage(
    tenantId: string,
    instance: { source: ConfigSource; hasAdministrator: boolean },
  ): Promise<boolean> {
    // Not for file-source configs or when an admin already exists
    if (instance.source !== 'database' || instance.hasAdministrator) return false;
    return this.claimWindowOpen(tenantId);
  }

  async mintClaim(tenantId: string, origin: string): Promise<MintedClaim> {
    // Housekeeping: remove expired claims and trim unapproved ones per tenant
    await this.db.query(`DELETE FROM setup_claims WHERE expires_at < now()`, {
      type: QueryTypes.DELETE,
    });
    // Keep MAX_LIVE_CLAIMS − 1 so the new insert stays under the limit
    await this.db.query(
      `DELETE FROM setup_claims
        WHERE tenant_id = :tenantId
          AND approved_at IS NULL
          AND id NOT IN (
            SELECT id FROM setup_claims
             WHERE tenant_id = :tenantId AND approved_at IS NULL
             ORDER BY created_at DESC
             LIMIT :keep
          )`,
      {
        type: QueryTypes.DELETE,
        replacements: { tenantId, keep: MAX_LIVE_CLAIMS - 1 },
      },
    );

    // creates a new token
    const token = mintToken();
    const expiresAt = new Date(Date.now() + CLAIM_TTL_MS);
    // Retry on code collision (human-readable code is not unique per tenant)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = mintClaimCode();
      const rows = await this.db.query<{ code: string }>(
        `INSERT INTO setup_claims (tenant_id, code, token_hash, origin, expires_at)
         VALUES (:tenantId, :code, :hash, :origin, :expiresAt)
         ON CONFLICT (tenant_id, code) DO NOTHING
         RETURNING code`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            tenantId,
            code,
            hash: hashToken(token),
            origin,
            expiresAt,
          },
        },
      );
      if (rows[0]) return { code: rows[0].code, token, expiresAt };
    }
    throw new Error('could not mint a setup claim code');
  }

  async pending(tenantId: string): Promise<PendingClaim[]> {
    return this.db.query<PendingClaim>(
      `SELECT code, origin, created_at, approved_at
         FROM setup_claims
        WHERE tenant_id = :tenantId AND redeemed_at IS NULL AND expires_at > now()
        ORDER BY created_at`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
  }

  async approve(tenantId: string, code: string): Promise<ApprovalResult> {
    if (!(await this.claimWindowOpen(tenantId))) return { status: 'closed' };

    const rows = await this.db.query<PendingClaim>(
      `UPDATE setup_claims
          SET approved_at = now()
        WHERE tenant_id = :tenantId
          AND code = :code
          AND redeemed_at IS NULL
          AND expires_at > now()
          AND approved_at IS NULL
        RETURNING code, origin, created_at, approved_at`,
      { type: QueryTypes.SELECT, replacements: { tenantId, code } },
    );
    if (rows[0]) return { status: 'approved', claim: rows[0] };

    // Distinguish already-approved from completely unknown codes
    const existing = await this.db.query<PendingClaim>(
      `SELECT code, origin, created_at, approved_at
         FROM setup_claims
        WHERE tenant_id = :tenantId AND code = :code AND redeemed_at IS NULL
          AND expires_at > now()`,
      { type: QueryTypes.SELECT, replacements: { tenantId, code } },
    );
    return existing[0] ? { status: 'already-approved', claim: existing[0] } : { status: 'unknown' };
  }

  async redeem(tenantId: string, token: string): Promise<PendingClaim | null> {
    const rows = await this.db.query<PendingClaim>(
      `UPDATE setup_claims
          SET redeemed_at = now()
        WHERE tenant_id = :tenantId
          AND token_hash = :hash
          AND approved_at IS NOT NULL
          AND redeemed_at IS NULL
          AND expires_at > now()
        RETURNING code, origin, created_at, approved_at`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, hash: hashToken(token) },
      },
    );
    return rows[0] ?? null;
  }

  // returns the claim that has not been redeemed yet and has the same token hash as the given token, or null if none exists
  async getLiveClaim(tenantId: string, token: string): Promise<PendingClaim | null> {
    const rows = await this.db.query<PendingClaim>(
      `SELECT code, origin, created_at, approved_at
         FROM setup_claims
        WHERE tenant_id = :tenantId AND token_hash = :hash
          AND redeemed_at IS NULL AND expires_at > now()`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, hash: hashToken(token) },
      },
    );
    return rows[0] ?? null;
  }

  async statusOf(tenantId: string, token: string): Promise<'pending' | 'approved' | 'gone'> {
    const rows = await this.db.query<{ approved: boolean }>(
      `SELECT (approved_at IS NOT NULL) AS approved
         FROM setup_claims
        WHERE tenant_id = :tenantId AND token_hash = :hash
          AND redeemed_at IS NULL AND expires_at > now()`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, hash: hashToken(token) },
      },
    );
    if (!rows[0]) return 'gone';
    return rows[0].approved ? 'approved' : 'pending';
  }

  /**
   * guideOpen returns whether the guided setup of the tenant with the given tenantId still runs.
   *
   * @param tenantId the tenant
   */
  async guideOpen(tenantId: string): Promise<boolean> {
    const [row] = await this.db.query<{ open: boolean }>(
      `SELECT (setup_completed_at IS NULL) AS open FROM tenants WHERE id = :tenantId`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
    return row?.open === true;
  }

  /**
   * readsAnyPage returns whether the given principals can read a synced page of the tenant with the given tenantId.
   *
   * @param tenantId the tenant
   * @param principals the principals of the administrator asking
   */
  async readsAnyPage(tenantId: string, principals: Principal[]): Promise<boolean> {
    return this.reach.readsAnyPage(tenantId, principals);
  }

  /**
   * complete ends the guided setup of the tenant with the given tenantId. It is refused while the given principals
   * cannot read a synced page.
   *
   * @param tenantId the tenant
   * @param principals the principals of the administrator completing it
   */
  async complete(tenantId: string, principals: Principal[]): Promise<boolean> {
    if (!(await this.reach.readsAnyPage(tenantId, principals))) return false;
    await this.db.query(
      `UPDATE tenants SET setup_completed_at = now()
        WHERE id = :tenantId AND setup_completed_at IS NULL`,
      { type: QueryTypes.UPDATE, replacements: { tenantId } },
    );
    return true;
  }

  /**
   * readableRepositories returns the repositories of the tenant with the given tenantId that the given principals can
   * read a page of, e.g. `acme/handbook`.
   *
   * @param tenantId the tenant
   * @param principals the principals of the administrator asking
   */
  async readableRepositories(tenantId: string, principals: Principal[]): Promise<string[]> {
    return this.reach.readableRepositories(tenantId, principals);
  }

  // The database is not up yet when this singleton is created
  private get reach(): SetupReachRepository {
    return new SetupReachRepository(this.db);
  }

  async latchFirstAdminLogin(tenantId: string): Promise<boolean> {
    const [, affected] = await this.db.query(
      `UPDATE tenants SET first_admin_login_at = now()
        WHERE id = :tenantId AND first_admin_login_at IS NULL`,
      { type: QueryTypes.UPDATE, replacements: { tenantId } },
    );
    return (typeof affected === 'number' ? affected : 0) > 0;
  }

  async reopen(tenantId: string): Promise<{ reopened: boolean; count: number }> {
    const rows = await this.db.query<{ count: number; was: Date | null }>(
      `UPDATE tenants
          SET first_admin_login_at = NULL,
              setup_reopened_at = now(),
              setup_reopen_count = setup_reopen_count + 1
        WHERE id = :tenantId AND first_admin_login_at IS NOT NULL
        RETURNING setup_reopen_count AS count, setup_reopened_at AS was`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
    if (rows[0]) return { reopened: true, count: Number(rows[0].count) };

    const [current] = await this.db.query<{ count: number }>(
      `SELECT setup_reopen_count AS count FROM tenants WHERE id = :tenantId`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
    return { reopened: false, count: Number(current?.count ?? 0) };
  }
}

export const setup = new SetupService();
