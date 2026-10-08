import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { ConfigService } from '../../config/config.service';
import { SetupService } from './setup.service';

const ALWAYS_REACHABLE_PREFIXES = [
  // API is always reachable since callers may need it to configure the instance
  '/api',

  // Static assets and branding must load even before setup is complete
  '/-/static',
  '/-/brand',

  // Health checks must never be redirected
  '/-/healthz',
  '/-/readyz',
];

const SETUP_FLOW_PREFIXES = ['/-/setup', '/-/config', '/-/connections'];

@Injectable()
export class SetupRedirectMiddleware implements NestMiddleware {
  constructor(
    private readonly config: ConfigService,
    private readonly setup: SetupService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Strip query string; only path matters for routing
    const path = req.originalUrl.split('?')[0];
    const pathMatchesAnyPrefix = (prefixes: string[]) =>
      prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

    if (req.method !== 'GET' || pathMatchesAnyPrefix(ALWAYS_REACHABLE_PREFIXES)) {
      next();
      return;
    }

    // A caller in a setup session but without an administrator configured must
    // stay within the setup flow
    if (req.caller?.viaSetup === true && !this.config.hasAdministrator) {
      if (pathMatchesAnyPrefix(SETUP_FLOW_PREFIXES)) {
        next();
        return;
      }
      // Redirect back to setup when they stray
      res.redirect(303, '/-/setup');
      return;
    }

    // If the claim page is showing, non-GET requests and the root path are
    // handled above; everything else redirects to the claim page
    if (
      path !== '/' &&
      (await this.setup.showsClaimPage(req.caller?.tenantId ?? '', {
        source: this.config.configSource,
        hasAdministrator: this.config.hasAdministrator,
      }))
    ) {
      res.redirect(303, '/');
      return;
    }

    next();
  }
}
