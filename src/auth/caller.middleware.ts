/**
 * Resolves the caller for every request
 *
 * Tries bearer token first, then session cookie
 * Attaches the resolved caller to `req.caller` for downstream use
 * Tenancy and logging context are also set
 *
 * Not applied to routes that skip auth (public endpoints declare their own guards)
 */

import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { AuthzService } from '../authz/authz.service';
import { ResolvedCaller } from '../authz/caller';
import { addLogContext } from '../common/logger';
import { TenancyService } from '../db/tenancy';
import { SetupService } from '../dashboard/setup/setup.service';
import { mcpResourceIdentifier } from './oauth/metadata';
import { OauthService } from './oauth/oauth.service';
import { SessionService } from './session.service';

declare module 'express-serve-static-core' {
  interface Request {
    caller?: ResolvedCaller;
    requestId?: string;
  }
}

@Injectable()
export class CallerMiddleware implements NestMiddleware {
  constructor(
    private readonly sessions: SessionService,
    private readonly oauth: OauthService,
    private readonly authz: AuthzService,
    private readonly tenancy: TenancyService,
    private readonly setup: SetupService,
  ) {}

  /** Resolve caller and pass errors to Express error handler */
  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      await this.resolve(req);
    } catch (err) {
      next(err);
      return;
    }
    next();
  }

  /** Determine the caller from the request */
  private async resolve(req: Request): Promise<void> {
    const tenant = await this.tenancy.resolveTenant(req);

    addLogContext({ tenant_id: tenant.id });

    const bearer = readBearer(req);
    if (bearer) {
      const bearerToken = await this.oauth.verifyAccess(bearer, mcpResourceIdentifier());
      req.caller = this.authz.resolve({
        tenantId: tenant.id,
        identity: bearerToken?.identity ?? null,
        rawGroupIds: bearerToken?.rawGroupIds ?? [],

        viaBearer: true,
      });
      return;
    }

    const session = await this.sessions.read(req);
    req.caller = this.authz.resolve({
      tenantId: tenant.id,
      identity: session?.identity ?? null,
      rawGroupIds: session?.rawGroupIds ?? [],
      viaBearer: false,

      // Setup sessions administer only the tenant they were created for
      viaSetup: session?.isSetup === true && (await this.setup.claimWindowOpen(tenant.id)),
    });
  }
}

/** Extract Bearer token from the Authorization header */
function readBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  // Matches "Bearer <token>" case-insensitively; captures <token> in Group 1
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Access the caller that CallerMiddleware attached; throws if middleware didn't run */
export function callerOf(req: Request): ResolvedCaller {
  if (!req.caller) {
    throw new Error('CallerMiddleware did not run for this route');
  }
  return req.caller;
}
