import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { ConfigService } from '../../config/config.service';
import { TenancyService } from '../../db/tenancy';
import { CLAIM_COOKIE } from './claim-cookie';
import { SetupService } from './setup.service';

/**
 * Admin-creation and initial-tenancy setup endpoints
 *
 * The claim flow lets the first visitor create the admin account and the default
 * tenant. The backend issues a signed cookie so the same browser can poll for
 * completion. Once an admin exists the route returns `gone`.
 *
 * Not restricted by the usual auth guard: there is no admin yet
 */
@Controller('api/setup')
export class SetupController {
  constructor(
    private readonly setup: SetupService,
    private readonly tenancy: TenancyService,
    private readonly config: ConfigService,
  ) {}

  @Get('claim')
  async claimStatus(@Req() req: Request, @Res() res: Response): Promise<void> {
    const tenant = await this.tenancy.resolveTenant(req);

    if (
      !(await this.setup.showsClaimPage(tenant.id, {
        source: this.config.configSource,
        hasAdministrator: this.config.hasAdministrator,
      }))
    ) {
      res.status(200).json({ status: 'gone' });
      return;
    }

    const token = req.cookies?.[CLAIM_COOKIE];
    const status =
      typeof token === 'string' && token.length > 0
        ? await this.setup.statusOf(tenant.id, token)
        : 'gone';
    res.status(200).json({ status });
  }
}
