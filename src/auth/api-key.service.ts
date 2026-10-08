/**
 * Issue, verify, and revoke API keys
 *
 * A key is a bearer token with a `spr_pk_` prefix, an embedded tenant, and a set of
 * scopes. Keys never carry the admin scope; an admin user may hold a key, but it grants
 * only their content-scoped access
 *
 * All key operations are tenant-scoped. The issue caller is stored as the key's principal
 * so revocation can narrow to keys a specific user issued
 */

import { Injectable } from '@nestjs/common';
import { Op } from 'sequelize';

import { CallerIdentity } from '../authz/caller';
import { subjectPrincipal } from '../common/principals';
import { ApiKey, initModels } from '../db/models';
import { API_KEY_PREFIX, hashToken, mintApiKey } from './tokens';

export interface IssuedKey {
  id: string;
  // Plain-text token returned once on creation; never stored
  token: string;
  expiresAt: Date;
}

@Injectable()
export class ApiKeyService {
  constructor() {
    initModels();
  }

  async issue(
    tenantId: string,
    identity: CallerIdentity,
    name: string,
    expiresAt: Date,
    scopes: string[] = ['read'],
    rawGroupIds: string[] = [],
  ): Promise<IssuedKey> {
    if (scopes.includes('admin')) {
      throw new Error(
        'API keys never carry admin scope. An admin may hold a key, but it grants only ' +
          'their content access.',
      );
    }
    const { token, hash } = mintApiKey();
    const row = await ApiKey.create({
      tenant_id: tenantId,
      principal: subjectPrincipal(identity.provider, identity.subject),
      provider: identity.provider,
      subject: identity.subject,
      email: identity.email?.toLowerCase() ?? null,
      name,
      hash,
      scopes,
      raw_group_ids: rawGroupIds,
      expires_at: expiresAt,
    });
    return { id: row.id, token, expiresAt };
  }

  async verify(token: string): Promise<{
    identity: CallerIdentity;
    scopes: string[];
    rawGroupIds: string[];
    tenantId: string;
  } | null> {
    if (!token.startsWith(API_KEY_PREFIX)) return null;
    const row = await ApiKey.findOne({
      where: {
        hash: hashToken(token),
        revoked_at: { [Op.is]: null },
        expires_at: { [Op.gt]: new Date() },
      },
    });
    if (!row) return null;

    // Fire-and-forget; never blocks the caller on a write
    void ApiKey.update({ last_used_at: new Date() }, { where: { id: row.id } }).catch(() => {});

    return {
      identity: { provider: row.provider, subject: row.subject, email: row.email },
      scopes: row.scopes ?? [],
      rawGroupIds: row.raw_group_ids ?? [],
      tenantId: row.tenant_id,
    };
  }

  async revoke(id: string): Promise<void> {
    await ApiKey.update({ revoked_at: new Date() }, { where: { id } });
  }

  /**
   * Revoke a key only if it belongs to the given tenant and principal
   */
  async revokeFor(tenantId: string, principal: string, id: string): Promise<boolean> {
    const [count] = await ApiKey.update(
      { revoked_at: new Date() },
      { where: { id, tenant_id: tenantId, principal, revoked_at: { [Op.is]: null } } },
    );
    return count > 0;
  }

  /**
   * List keys issued by a principal within a tenant
   */
  async listFor(tenantId: string, principal: string) {
    return ApiKey.findAll({
      where: { tenant_id: tenantId, principal },
      attributes: ['id', 'name', 'scopes', 'expires_at', 'last_used_at', 'revoked_at'],
      order: [['created_at', 'DESC']],
    });
  }
}
