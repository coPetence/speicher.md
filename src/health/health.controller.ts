/**
 * Liveness and readiness endpoints for orchestration probes
 *
 * K8s-style `/healthz` and `/readyz` under path `-` to keep them out of API docs
 *
 * `/healthz` always succeeds -- process running means it is alive
 * `/readyz` checks whether the service can accept traffic
 *
 * Not served by a framework health check to keep the contract minimal
 */
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';

import { HealthService } from './health.service';

@Controller('-')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Always respond 200 -- the process is alive YAYY */
  @Get('healthz')
  healthz(@Res() res: Response): void {
    res.status(200).json({ status: 'ok' });
  }

  /** Aggregate sub-system health; 200 when all pass, 503 otherwise */
  @Get('readyz')
  async readyz(@Res() res: Response): Promise<void> {
    const { ready, checks } = await this.health.readiness();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready', checks });
  }
}
