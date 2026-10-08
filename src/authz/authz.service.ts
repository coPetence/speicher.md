/**
 * Authorization resolution and repo access checks
 *
 * Wraps the stateless helpers from caller.ts with NestJS DI and config access
 * Resolves a raw Caller into a ResolvedCaller by computing internal groups,
 * principals and admin status, then provides isMaintainer and repo-id queries
 * on top
 */
import { Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';

import { ConfigService } from '../config/config.service';
import { toPgTextArray } from '../db/pg-array';
import { getSequelize } from '../db/sequelize';
import { Principal } from '../common/principals';
import { Caller, ResolvedCaller, isAdminCaller, isMaintainerOf, principalsFor } from './caller';

@Injectable()
export class AuthzService {
  constructor(private readonly config: ConfigService) {}

  resolve(caller: Caller): ResolvedCaller {
    // Internal groups come from config, keyed by provider and raw group IDs
    const internalGroups = caller.identity
      ? this.config.resolveInternalGroups(
          caller.identity.provider,
          caller.rawGroupIds,
          caller.identity,
        )
      : [];
    const principals = principalsFor(caller.identity, internalGroups);
    return {
      ...caller,
      internalGroups,
      principals,
      isAdmin: isAdminCaller(
        principals,
        this.config.adminPrincipals(),
        caller.viaBearer,
        caller.viaSetup === true,
      ),
    };
  }

  isMaintainer(caller: ResolvedCaller, repoMaintainerPrincipals: Principal[]): boolean {
    return isMaintainerOf(caller.principals, repoMaintainerPrincipals, caller.viaBearer);
  }

  async operationalRepoIds(caller: ResolvedCaller): Promise<'all' | string[]> {
    if (caller.isAdmin) return 'all';
    if (caller.principals.length === 0) return [];
    // Finds repos where at least one of the caller's principals appears in
    // maintainer_principals (a text[] column), using the PostgreSQL && overlap operator
    const rows = await getSequelize().query<{ id: string }>(
      `SELECT id FROM repos
        WHERE tenant_id = :tenantId
          AND maintainer_principals && CAST(:principals AS text[])`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId: caller.tenantId, principals: toPgTextArray(caller.principals) },
      },
    );
    return rows.map((r) => r.id);
  }
}
