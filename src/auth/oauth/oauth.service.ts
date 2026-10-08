/**
 * OAuth 2.0 authorization code grant with PKCE
 *
 * Issues authorization codes, exchanges them for token pairs, and rotates
 * refresh tokens on each use
 * Uses hashed tokens in the database so the raw secret is never persisted
 *
 * Not an authorisation server -- the client is authenticated by the tenant
 * who configured it, not by client_secret
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Op } from 'sequelize';

import { CallerIdentity } from '../../authz/caller';
import { subjectPrincipal } from '../../common/principals';
import { OauthCode, OauthGrant, initModels } from '../../db/models';
import { SessionService } from '../session.service';
import {
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
  hashToken,
  mintPrefixed,
  mintToken,
} from '../tokens';

const ACCESS_TTL_MS = 60 * 60_000;

const CODE_TTL_MS = 5 * 60_000;

export const OAUTH_SCOPES = ['read'] as const;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string;
}

export interface CodeRequest {
  tenantId: string;
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
  identity: CallerIdentity;
  rawGroupIds: string[];
}

export class OauthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class OauthService {
  constructor(private readonly sessions: SessionService) {
    initModels();
  }

  async issueCode(request: CodeRequest): Promise<string> {
    const code = mintToken(32);
    await OauthCode.create({
      tenant_id: request.tenantId,
      code_hash: hashToken(code),
      client_id: request.clientId,
      client_name: request.clientName,
      redirect_uri: request.redirectUri,
      resource: request.resource,
      scope: OAUTH_SCOPES.join(' '),
      code_challenge: request.codeChallenge,
      provider: request.identity.provider,
      subject: request.identity.subject,
      email: request.identity.email?.toLowerCase() ?? null,
      raw_group_ids: request.rawGroupIds,
      expires_at: new Date(Date.now() + CODE_TTL_MS),
    });
    return code;
  }

  /**
   * Exchanges an authorization code for an access and refresh token
   *
   * Destroys the code row on read to enforce single-use
   * Verifies PKCE challenge, client_id, redirect_uri and expiry before issuing
   */
  async exchangeCode(
    tenantId: string,
    code: string,
    clientId: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<IssuedTokens> {
    const row = await OauthCode.findOne({
      where: { tenant_id: tenantId, code_hash: hashToken(code) },
    });
    if (!row) throw new OauthError('invalid_grant', 'unknown or already-used authorization code');
    await OauthCode.destroy({ where: { id: row.id } });

    if (row.expires_at.getTime() <= Date.now()) {
      throw new OauthError('invalid_grant', 'authorization code has expired');
    }
    if (row.client_id !== clientId) {
      throw new OauthError('invalid_grant', 'authorization code was issued to another client');
    }
    if (row.redirect_uri !== redirectUri) {
      throw new OauthError(
        'invalid_grant',
        'redirect_uri does not match the authorization request',
      );
    }
    if (!verifyPkce(codeVerifier, row.code_challenge)) {
      throw new OauthError('invalid_grant', 'code_verifier does not match the challenge');
    }

    const access = mintPrefixed(ACCESS_TOKEN_PREFIX);
    const refresh = mintPrefixed(REFRESH_TOKEN_PREFIX);
    const refreshTtl = this.sessions.sessionTtlMs(row.provider);
    await OauthGrant.create({
      tenant_id: tenantId,
      principal: subjectPrincipal(row.provider, row.subject),
      client_id: row.client_id,
      client_name: row.client_name,
      resource: row.resource,
      access_hash: access.hash,
      refresh_hash: refresh.hash,
      scopes: [...OAUTH_SCOPES],
      provider: row.provider,
      subject: row.subject,
      email: row.email,
      raw_group_ids: row.raw_group_ids,
      access_expires_at: new Date(Date.now() + ACCESS_TTL_MS),
      refresh_expires_at: new Date(Date.now() + refreshTtl),
    });

    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresInSeconds: Math.floor(ACCESS_TTL_MS / 1000),
      scope: row.scope,
    };
  }

  /**
   * Rotates a refresh token and issues a new access token
   *
   * The existing grant row is updated in place so the grant's id and created_at
   * stay stable for the client
   */
  async refresh(tenantId: string, refreshToken: string, clientId: string): Promise<IssuedTokens> {
    const row = await OauthGrant.findOne({
      where: {
        tenant_id: tenantId,
        refresh_hash: hashToken(refreshToken),
        revoked_at: { [Op.is]: null },
      },
    });

    if (!row) throw new OauthError('invalid_grant', 'unknown or superseded refresh token');
    if (row.client_id !== clientId) {
      throw new OauthError('invalid_grant', 'refresh token was issued to another client');
    }
    if (row.refresh_expires_at !== null && row.refresh_expires_at.getTime() <= Date.now()) {
      throw new OauthError('invalid_grant', 'refresh token has expired');
    }

    const access = mintPrefixed(ACCESS_TOKEN_PREFIX);
    const refresh = mintPrefixed(REFRESH_TOKEN_PREFIX);
    await OauthGrant.update(
      {
        access_hash: access.hash,
        refresh_hash: refresh.hash,
        access_expires_at: new Date(Date.now() + ACCESS_TTL_MS),
      },
      { where: { id: row.id } },
    );

    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresInSeconds: Math.floor(ACCESS_TTL_MS / 1000),
      scope: row.scopes.join(' '),
    };
  }

  /**
   * Verifies an access token, returning the identity or null
   *
   * Null for wrong prefix, revoked, expired, or resource mismatch so callers
   * can fall through to other authentication methods
   */
  async verifyAccess(
    token: string,
    expectedResource: string | null,
  ): Promise<{
    identity: CallerIdentity;
    scopes: string[];
    rawGroupIds: string[];
    tenantId: string;
  } | null> {
    if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return null;
    const row = await OauthGrant.findOne({
      where: {
        access_hash: hashToken(token),
        revoked_at: { [Op.is]: null },
        access_expires_at: { [Op.gt]: new Date() },
      },
    });
    if (!row) return null;
    if (expectedResource !== null && row.resource !== expectedResource) return null;

    void OauthGrant.update({ last_used_at: new Date() }, { where: { id: row.id } }).catch(() => {});

    return {
      identity: { provider: row.provider, subject: row.subject, email: row.email },
      scopes: row.scopes ?? [],
      rawGroupIds: row.raw_group_ids ?? [],
      tenantId: row.tenant_id,
    };
  }

  /**
   * Revokes a grant row so its tokens are no longer accepted
   */
  async revoke(tenantId: string, principal: string, id: string): Promise<boolean> {
    const [count] = await OauthGrant.update(
      { revoked_at: new Date() },
      { where: { id, tenant_id: tenantId, principal, revoked_at: { [Op.is]: null } } },
    );
    return count > 0;
  }

  /**
   * Lists active grants for a principal, newest first
   */
  async listFor(tenantId: string, principal: string) {
    return OauthGrant.findAll({
      where: { tenant_id: tenantId, principal, revoked_at: { [Op.is]: null } },
      attributes: [
        'id',
        'client_id',
        'client_name',
        'created_at',
        'last_used_at',
        'refresh_expires_at',
      ],
      order: [['created_at', 'DESC']],
    });
  }
}

/**
 * Verifies a PKCE code_verifier against the stored S256 challenge
 */
function verifyPkce(verifier: string, challenge: string): boolean {
  if (verifier === '') return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return computed === challenge;
}
